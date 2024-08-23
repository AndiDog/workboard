package api

import (
	"context"
	"fmt"
	"log"
	"os"

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
func convertGitHubToWorkboardCodeReview(issue *github.Issue, existingCodeReviews map[string]*proto.CodeReview, gitHubUserSelf string) (string, *proto.CodeReview, error) {
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
			Url:   *issue.HTMLURL,
			Title: *issue.Title,
			Repo: &proto.GitHubRepo{
				Name:             "reponame-TODO",
				OrganizationName: "orgname-TODO",
				// These aren't filled (TODO)
				// Name:             *issue.Repository.Name,
				// OrganizationName: *issue.Repository.Organization.Name,
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
	}

	return id, codeReview, nil
}

func (s *WorkboardServer) ensureGitHubClient() *github.Client {
	if s.gitHubClient == nil {
		s.gitHubClient = github.NewClient(nil)
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
		id, codeReview, err := convertGitHubToWorkboardCodeReview(issue, codeReviews, gitHubUser)
		if err != nil {
			return nil, err
		}
		codeReviews[id] = codeReview
	}

	err = s.db.Set("code_reviews", &codeReviews)
	if err != nil {
		return nil, errors.Wrapf(err, "failed to store code reviews in database")
	}

	return codeReviews, nil
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
