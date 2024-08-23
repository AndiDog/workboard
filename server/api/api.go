package api

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"time"

	"github.com/google/go-github/v63/github"
	"github.com/pkg/errors"
	"github.com/xeonx/timeago"
	"go.uber.org/zap"

	"andidog.de/workboard/server/database"
	"andidog.de/workboard/server/proto"
)

type WorkboardServer struct {
	proto.UnimplementedWorkboardServer

	db     *database.Database
	logger *zap.SugaredLogger

	gitHubClient *github.Client
}

func NewWorkboardServer(db *database.Database, logger *zap.SugaredLogger) (*WorkboardServer, error) {
	if db == nil {
		return nil, errors.New("db must not be nil")
	}
	return &WorkboardServer{
		db:     db,
		logger: logger,
	}, nil
}

type PR struct {
	GitHubURL string `json:"githubUrl"`
}

// convertGitHubToWorkboardCodeReview converts to our protobuf message type `CodeReview` and in case the code review
// already exists, merges the new information in `issue` with existing fields. The existing value is not mutated.
func convertGitHubToWorkboardCodeReview(issue *github.Issue, pr *github.PullRequest, owner string, repo string, existingCodeReviews map[string]*proto.CodeReview, gitHubUserSelf string) (string, *proto.CodeReview, error) {
	id := *issue.HTMLURL // PR URL doesn't change and is unique, so use it as ID

	gitHubPullRequestStatus := proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_UNSPECIFIED
	switch *issue.State {
	case "open":
		gitHubPullRequestStatus = proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_OPEN
	case "closed":
		gitHubPullRequestStatus = proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_CLOSED
	}
	if issue.PullRequestLinks.MergedAt != nil {
		gitHubPullRequestStatus = proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_MERGED
	}

	lastUpdatedDescription := ""
	var updatedAtTimestamp int64 = 0
	if issue.UpdatedAt != nil {
		lastUpdatedDescription = timeago.NoMax(timeago.English).Format(issue.UpdatedAt.Time)
		updatedAtTimestamp = issue.UpdatedAt.Time.Unix()
	}

	codeReview := &proto.CodeReview{
		Id:     id,
		Status: proto.CodeReviewStatus_CODE_REVIEW_STATUS_NEW,
		GithubFields: &proto.GitHubPullRequestFields{
			Url:    *issue.HTMLURL,
			Title:  *issue.Title,
			Number: int64(*issue.Number),
			Repo: &proto.GitHubRepo{
				Name:             repo,
				OrganizationName: owner,
			},
			Status:             gitHubPullRequestStatus,
			UpdatedAtTimestamp: updatedAtTimestamp,
		},
		RenderOnlyFields: &proto.CodeReviewRenderOnlyFields{
			AuthorIsSelf:           issue.User != nil && issue.User.Name != nil && *issue.User.Name == gitHubUserSelf,
			LastUpdatedDescription: lastUpdatedDescription,
		},
	}
	if existingCodeReview, ok := existingCodeReviews[id]; ok {
		if existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_UNSPECIFIED {
			codeReview.Status = existingCodeReview.Status
		}
		if existingCodeReview.LastChangedTimestamp > codeReview.LastChangedTimestamp {
			codeReview.LastChangedTimestamp = existingCodeReview.LastChangedTimestamp
		}
	} else {
		codeReview.LastChangedTimestamp = issue.UpdatedAt.Time.Unix()
	}

	return id, codeReview, nil
}

var gitHubHtmlUrlRe = regexp.MustCompile("^https://github.com/([^/]+)/([^/]+)/pull/[1-9][0-9]*")

func getOwnerAndRepoFromGitHubIssue(issue *github.Issue, logger *zap.SugaredLogger) (string, string, error) {
	m := gitHubHtmlUrlRe.FindStringSubmatch(*issue.HTMLURL)
	if m == nil {
		logger.Errorw("No match parsing GitHub HTML URL field for PR", "url", *issue.HTMLURL)
		return "", "", errors.New("failed to parse GitHub HTML URL field for PR")
	}
	owner := m[1]
	repo := m[2]
	return owner, repo, nil
}

func sugarLoggerWithGitHubPullRequestFields(logger *zap.SugaredLogger, gitHubFields *proto.GitHubPullRequestFields) *zap.SugaredLogger {
	return logger.With("gitHubPullRequestUrl", gitHubFields.Url)
}

func (s *WorkboardServer) ensureGitHubClient() *github.Client {
	logger := s.logger
	if s.gitHubClient == nil {
		s.gitHubClient = github.NewClient(nil)
		gitHubToken := os.Getenv("WORKBOARD_GITHUB_TOKEN")
		if gitHubToken != "" {
			logger.Debug("Created GitHub client with token")
			s.gitHubClient = s.gitHubClient.WithAuthToken(gitHubToken)
		} else {
			logger.Warn("Created GitHub client without token. Rate limits may occur very soon with anonymous access to the GitHub API!")
		}
	}
	return s.gitHubClient
}

func (s *WorkboardServer) getGitHubUser() (string, error) {
	logger := s.logger
	logger.Debug("Reading GitHub user from database")

	var gitHubUser string
	ok, err := s.db.Get("github_user", &gitHubUser)
	if err != nil {
		logger.Errorw("Failed to read GitHub user from database", "err", err)
		return "", err
	}
	if !ok {
		gitHubUser := os.Getenv("TEST_GITHUB_USER")
		if gitHubUser != "" {
			err = s.db.Set("github_user", gitHubUser)
			if err != nil {
				logger.Errorw("Failed to write test GitHub user into database", "err", err)
				return "", err
			}
		} else {
			return "", errors.New("GitHub user not configured")
		}
	}
	logger.Debugw("Found GitHub user in database", "gitHubUser", gitHubUser)
	return gitHubUser, nil
}

// getCodeReviewById returns the code review by ID, or nil if none exists with that ID
func (s *WorkboardServer) getCodeReviewById(codeReviewId string) (*proto.CodeReview, error) {
	codeReviews, err := s.getCodeReviews()
	if err != nil {
		return nil, err
	}

	return codeReviews[codeReviewId], nil
}

func (s *WorkboardServer) getCodeReviews() (map[string]*proto.CodeReview, error) {
	logger := s.logger

	codeReviews := map[string]*proto.CodeReview{}
	ok, err := s.db.Get("code_reviews", &codeReviews)
	if err != nil {
		return nil, err
	}
	if !ok {
		logger.Debug("No code reviews stored in database yet")
	}

	return codeReviews, nil
}

func (s *WorkboardServer) refreshCodeReviews(ctx context.Context) (map[string]*proto.CodeReview, error) {
	logger := s.logger

	codeReviews := map[string]*proto.CodeReview{}
	ok, err := s.db.Get("code_reviews", &codeReviews)
	if err != nil {
		return nil, err
	}
	if !ok {
		logger.Debug("No code reviews stored in database yet")
	}

	gitHubUser, err := s.getGitHubUser()
	if err != nil {
		return nil, err
	}
	logger = logger.With("gitHubUser", gitHubUser)

	client := s.ensureGitHubClient()
	query := fmt.Sprintf(`author:"%s" is:pr is:open`, gitHubUser)
	logger = logger.With("query", query)
	logger.Debug("Querying GitHub PRs")
	res, _, err := client.Search.Issues(ctx, query, &github.SearchOptions{
		// Not needed, but make things idempotent
		Sort:  "created",
		Order: "desc",
		ListOptions: github.ListOptions{
			// TODO paging
			Page:    1,
			PerPage: 100,
		},
	})
	logger.Debug("Queried GitHub PRs")
	if err != nil {
		return nil, errors.Wrapf(err, "failed to search GitHub PRs for user %q", gitHubUser)
	}

	for _, issue := range res.Issues {
		owner, repo, err := getOwnerAndRepoFromGitHubIssue(issue, logger)
		if err != nil {
			return nil, err
		}
		pr, _, err := client.PullRequests.Get(ctx, owner, repo, *issue.Number)
		if err != nil {
			logger.Errorw("Failed to fetch GitHub PR details for reviews refresh", "err", err, "url", *issue.HTMLURL)
			return nil, errors.Wrap(err, "failed to fetch GitHub PR details for reviews refresh")
		}

		id, codeReview, err := convertGitHubToWorkboardCodeReview(issue, pr, owner, repo, codeReviews, gitHubUser)
		if err != nil {
			return nil, err
		}
		codeReviews[id] = codeReview
	}

	err = s.db.Set("code_reviews", &codeReviews)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store code reviews in database")
	}

	return codeReviews, nil
}

func (s *WorkboardServer) storeCodeReview(codeReview *proto.CodeReview) error {
	codeReviews, err := s.getCodeReviews()
	if err != nil {
		return err
	}

	codeReviews[codeReview.Id] = codeReview

	err = s.db.Set("code_reviews", &codeReviews)
	if err != nil {
		return errors.Wrap(err, "failed to store code reviews in database")
	}
	return nil
}

func (s *WorkboardServer) GetCodeReviews(ctx context.Context, cmd *proto.GetCodeReviewsQuery) (*proto.GetCodeReviewsResponse, error) {
	logger := s.logger
	logger.Info("GetCodeReviews")

	codeReviews, err := s.refreshCodeReviews(ctx)
	if err != nil {
		return nil, err
	}

	res := &proto.GetCodeReviewsResponse{}
	for _, codeReview := range codeReviews {
		res.CodeReviews = append(res.CodeReviews, codeReview)
	}
	return res, nil
}

func (s *WorkboardServer) MarkReviewed(ctx context.Context, cmd *proto.MarkReviewedCommand) (*proto.CommandResponse, error) {
	log.Printf("MarkReviewed")

	var pr PR
	ok, err := s.db.Get("andi", &pr)
	if err != nil {
		return nil, err
	}
	fmt.Printf("ok=%v pr=%+v\n", ok, pr)

	pr.GitHubURL = "https://andi-test"
	err = s.db.Set("andi", &pr)
	if err != nil {
		return nil, err
	}
	fmt.Printf("value set fine\n")

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) refreshCodeReview(ctx context.Context, codeReviewId string) (*proto.CodeReview, error) {
	logger := s.logger.With("codeReviewId", codeReviewId)
	logger.Info("Refreshing code review")

	codeReview, err := s.getCodeReviewById(codeReviewId)
	if err != nil {
		return nil, err
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
	}

	gitHubUser, err := s.getGitHubUser()
	if err != nil {
		return nil, err
	}
	logger = logger.With("gitHubUser", gitHubUser)

	client := s.ensureGitHubClient()
	logger.Debug("Querying GitHub PR")
	issue, _, err := client.Issues.Get(ctx, codeReview.GithubFields.Repo.OrganizationName, codeReview.GithubFields.Repo.Name, int(codeReview.GithubFields.Number))
	logger.Debug("Queried GitHub PR")
	if err != nil {
		return nil, errors.Wrap(err, "failed to get GitHub PR")
	}

	pr, _, err := client.PullRequests.Get(ctx, codeReview.GithubFields.Repo.OrganizationName, codeReview.GithubFields.Repo.Name, int(codeReview.GithubFields.Number))
	if err != nil {
		logger.Errorw("Failed to fetch GitHub PR details for review refresh", "err", err, "url", *issue.HTMLURL)
		return nil, errors.Wrap(err, "failed to fetch GitHub PR details for review refresh")
	}

	codeReviews, err := s.getCodeReviews()
	if err != nil {
		return nil, err
	}
	id, codeReview, err := convertGitHubToWorkboardCodeReview(issue, pr, codeReview.GithubFields.Repo.OrganizationName, codeReview.GithubFields.Repo.Name, codeReviews, gitHubUser)
	if err != nil {
		return nil, err
	}
	codeReviews[id] = codeReview
	err = s.db.Set("code_reviews", &codeReviews)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store code reviews in database")
	}

	return codeReview, nil
}

func (s *WorkboardServer) SnoozeUntilUpdate(ctx context.Context, cmd *proto.SnoozeUntilUpdateCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("SnoozeUntilUpdate")

	// The user may have just done something on the PR, such as triggering a test, commenting, leaving a review
	// comment or the like. Therefore, we need to update our stale `updatedAt` field in the database and only
	// want to return from snooze once another update happened after the user clicked the snooze button.
	codeReview, err := s.refreshCodeReview(ctx, cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to refresh code review in order to snooze until update")
	}

	if codeReview.GithubFields != nil {
		snoozeUntilUpdatedAtChangedFrom := codeReview.GithubFields.UpdatedAtTimestamp

		logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)
		logger = logger.With("snoozeUntilUpdatedAtChangedFrom", snoozeUntilUpdatedAtChangedFrom)

		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE
		codeReview.LastChangedTimestamp = time.Now().Unix()
		codeReview.SnoozeUntilUpdatedAtChangedFrom = snoozeUntilUpdatedAtChangedFrom

		logger.Info(
			"Snoozed GitHub PR until update")
	} else {
		return nil, errors.Wrap(err, "only GitHub PRs supported in SnoozeUntilUpdate until now")
	}

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store snoozed code review")
	}

	return &proto.CommandResponse{}, nil
}
