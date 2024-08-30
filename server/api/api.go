package api

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/google/go-github/v63/github"
	"github.com/pkg/errors"
	"go.uber.org/zap"

	"andidog.de/workboard/server/database"
	"andidog.de/workboard/server/proto"
)

const deleteAfterNowSeconds = 86400 * 30

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
func convertGitHubToWorkboardCodeReview(issue *github.Issue, pr *github.PullRequest, owner string, repo string, existingCodeReviews map[string]*proto.CodeReview, gitHubUserSelf string, logger *zap.SugaredLogger) (string, *proto.CodeReview, error) {
	id := *issue.HTMLURL // PR URL doesn't change and is unique, so use it as ID

	gitHubPullRequestStatus := proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_UNSPECIFIED
	switch *issue.State {
	case "open":
		gitHubPullRequestStatus = proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_OPEN
	case "closed":
		gitHubPullRequestStatus = proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_CLOSED
	}
	if issue.PullRequestLinks.MergedAt != nil && *issue.State == "closed" {
		gitHubPullRequestStatus = proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_MERGED
	}

	var updatedAtTimestamp int64 = 0
	if issue.UpdatedAt != nil {
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
			AuthorIsSelf: issue.User != nil && issue.User.Name != nil && *issue.User.Name == gitHubUserSelf,
		},
		LastChangedTimestamp:                       0,
		LastUpdatedTimestamp:                       updatedAtTimestamp,
		SnoozeUntilUpdatedAtChangedFrom:            0,
		BringBackToReviewIfNotMergedUntilTimestamp: 0,
		SnoozeUntilTimestamp:                       0,
	}
	existingCodeReview, hasExistingCodeReview := existingCodeReviews[id]
	if !hasExistingCodeReview {
		codeReview.LastChangedTimestamp = issue.UpdatedAt.Time.Unix()

		return id, codeReview, nil
	}

	if existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_UNSPECIFIED {
		codeReview.Status = existingCodeReview.Status
	}
	if existingCodeReview.LastChangedTimestamp > codeReview.LastChangedTimestamp {
		codeReview.LastChangedTimestamp = existingCodeReview.LastChangedTimestamp
	}

	codeReview.SnoozeUntilUpdatedAtChangedFrom = existingCodeReview.SnoozeUntilUpdatedAtChangedFrom
	codeReview.BringBackToReviewIfNotMergedUntilTimestamp = existingCodeReview.BringBackToReviewIfNotMergedUntilTimestamp
	codeReview.SnoozeUntilTimestamp = existingCodeReview.SnoozeUntilTimestamp

	//
	// State machine, the smart part of the application :)
	//

	updateLastChangedToNow := false
	nowTimestamp := time.Now().Unix()

	if (existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_DELETED &&
		existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_MERGED) &&
		gitHubPullRequestStatus == proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_MERGED {
		if existingCodeReview.Status == proto.CodeReviewStatus_CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE {
			logger.Info("Marking code review as deleted because it was merged")
			codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_DELETED
			codeReview.DeleteAfterTimestamp = nowTimestamp + deleteAfterNowSeconds
		} else {
			logger.Info("Marking code review as merged")
			codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_MERGED
		}
		updateLastChangedToNow = true
	}

	if existingCodeReview.Status == proto.CodeReviewStatus_CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE &&
		existingCodeReview.BringBackToReviewIfNotMergedUntilTimestamp <= nowTimestamp {
		logger.Info("Passed the time until code review was meant to be merged, marking as must-review again")
		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_MUST_REVIEW
		updateLastChangedToNow = true
		codeReview.BringBackToReviewIfNotMergedUntilTimestamp = 0
	}

	if existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_DELETED &&
		existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_CLOSED &&
		gitHubPullRequestStatus == proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_CLOSED {
		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_CLOSED
		updateLastChangedToNow = true
	}

	if existingCodeReview.Status == proto.CodeReviewStatus_CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME &&
		existingCodeReview.SnoozeUntilTimestamp <= nowTimestamp {
		logger.Info("Passed the time until code review was snoozed, unsnoozing it")
		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_MUST_REVIEW
		updateLastChangedToNow = true
		codeReview.SnoozeUntilTimestamp = 0
	}

	if existingCodeReview.Status == proto.CodeReviewStatus_CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE &&
		updatedAtTimestamp != existingCodeReview.SnoozeUntilUpdatedAtChangedFrom {
		logger.Infow("Snoozed code review was updated in GitHub PR, unsnoozing it", "snoozeUntilUpdatedAtChangedFrom", existingCodeReview.SnoozeUntilUpdatedAtChangedFrom, "updatedAtTimestamp", updatedAtTimestamp)

		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE
		updateLastChangedToNow = true
		codeReview.SnoozeUntilUpdatedAtChangedFrom = 0
	}

	if updateLastChangedToNow {
		codeReview.LastChangedTimestamp = nowTimestamp
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

func (s *WorkboardServer) DeleteReview(ctx context.Context, cmd *proto.DeleteReviewCommand) (*proto.CommandResponse, error) {
	logger := s.logger
	logger.Info("DeleteReview")

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		logger.Errorw("Failed to get code review in order to delete it", "err", err)
		return nil, errors.Wrap(err, "failed to get code review in order to delete it")
	}

	logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)

	codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_DELETED
	nowTimestamp := time.Now().Unix()
	codeReview.LastChangedTimestamp = nowTimestamp
	codeReview.DeleteAfterTimestamp = nowTimestamp + deleteAfterNowSeconds

	logger.Info(
		"Marked code review as deleted")

	err = s.storeCodeReview(codeReview)
	if err != nil {
		logger.Errorw("Failed to store deleted code review", "err", err)
		return nil, errors.Wrap(err, "failed to store deleted code review")
	}

	return &proto.CommandResponse{}, nil
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

	// Used for the whole function incl. loop bodies (see hints below)
	var err error

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
	logger.Info("Refreshing code reviews")

	client := s.ensureGitHubClient()

	for _, query := range []string{fmt.Sprintf(`author:"%s" is:pr is:open`, gitHubUser)} {
		logger = logger.With("query", query)
		logger.Debug("Querying GitHub PRs")

		// Don't use `err :=` in this loop since we want to break out of the loop and store the current
		// state on errors, requiring the outside `err` variable to be used.
		var res *github.IssuesSearchResult
		res, _, err = client.Search.Issues(ctx, query, &github.SearchOptions{
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
			err = errors.Wrapf(err, "failed to search GitHub PRs for user %q", gitHubUser)
			break
		}

		for _, issue := range res.Issues {
			var owner, repo string
			owner, repo, err = getOwnerAndRepoFromGitHubIssue(issue, logger)
			if err != nil {
				break
			}
			logger := logger.With("url", *issue.HTMLURL)
			logger.Debug("Querying GitHub PR")
			var pr *github.PullRequest
			pr, _, err = client.PullRequests.Get(ctx, owner, repo, *issue.Number)
			if err != nil {
				err = errors.Wrap(err, "failed to fetch GitHub PR details for reviews refresh")
				break
			}
			logger.Debug("Queried GitHub PR")

			var id string
			var codeReview *proto.CodeReview
			id, codeReview, err = convertGitHubToWorkboardCodeReview(issue, pr, owner, repo, codeReviews, gitHubUser, logger)
			if err != nil {
				break
			}
			codeReviews[id] = codeReview
		}

		if err != nil {
			break
		}
	}

	logger.Debug("Storing refreshed code reviews")
	storeErr := s.db.Set("code_reviews", &codeReviews)
	if storeErr != nil {
		if err == nil {
			return nil, errors.Wrap(storeErr, "failed to store code reviews in database")
		} else {
			logger.Errorw("Failed to store code reviews in database", "err", storeErr)
		}
	}

	if err != nil {
		return nil, err
	}

	logger.Info("Refreshed code reviews")
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

func (s *WorkboardServer) GetCodeReviews(ctx context.Context, query *proto.GetCodeReviewsQuery) (*proto.GetCodeReviewsResponse, error) {
	logger := s.logger
	logger.Info("GetCodeReviews")

	var lastCodeReviewsRefresh int64 = 0
	var err error

	if !query.ForceRefresh {
		_, err = s.db.Get("last_code_reviews_refresh", &lastCodeReviewsRefresh)
		if err != nil {
			logger.Errorw("Failed to read code reviews from database", "err", err)
			return nil, err
		}
	}
	nowTimestamp := time.Now().Unix()
	var codeReviews map[string]*proto.CodeReview
	if query.ForceRefresh || (lastCodeReviewsRefresh < nowTimestamp && nowTimestamp-lastCodeReviewsRefresh > 3600) {
		if query.ForceRefresh {
			logger.Debug("Forced code reviews refresh")
		} else if lastCodeReviewsRefresh == 0 {
			logger.Debug("No code reviews refresh known in database, triggering refresh")
		} else {
			logger.Debugw("Last code reviews refresh was long ago, triggering refresh", "secondsAgo", nowTimestamp-lastCodeReviewsRefresh)
		}
		codeReviews, err = s.refreshCodeReviews(ctx)
		if err != nil {
			logger.Errorw("Failed to refresh code reviews", "err", err)
			return nil, err
		}

		err = s.db.Set("last_code_reviews_refresh", &nowTimestamp)
		if err != nil {
			logger.Errorw("Failed to store last code reviews refresh in database", "err", err)
			return nil, err
		}
	} else {
		logger.Debug("Last code reviews refresh is recent, returning cached code reviews without refresh")
		codeReviews, err = s.getCodeReviews()

		if err != nil {
			logger.Errorw("Failed to get code reviews", "err", err)
			return nil, err
		}
	}

	res := &proto.GetCodeReviewsResponse{}
	for _, codeReview := range codeReviews {
		res.CodeReviews = append(res.CodeReviews, codeReview)
	}
	return res, nil
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
	id, codeReview, err := convertGitHubToWorkboardCodeReview(issue, pr, codeReview.GithubFields.Repo.OrganizationName, codeReview.GithubFields.Repo.Name, codeReviews, gitHubUser, logger)
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

func (s *WorkboardServer) MarkMustReview(ctx context.Context, cmd *proto.MarkMustReviewCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("MarkMustReview")

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to mark it must-review")
	}

	if codeReview.GithubFields != nil {
		logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)

		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_MUST_REVIEW
		nowTimestamp := time.Now().Unix()
		codeReview.LastChangedTimestamp = nowTimestamp

		logger.Info(
			"Marked GitHub PR as must-reviewed")
	} else {
		return nil, errors.Wrap(err, "only GitHub PRs supported in MarkMustReview until now")
	}

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store must-review code review")
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) RefreshReview(ctx context.Context, cmd *proto.RefreshReviewCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("RefreshReview")

	codeReview, err := s.refreshCodeReview(ctx, cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to refresh code review")
	}

	// Code review may have changed by the state machine
	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store refreshed code review")
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) ReviewedDeleteOnMerge(ctx context.Context, cmd *proto.ReviewedDeleteOnMergeCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("ReviewedDeleteOnMerge")

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to mark it reviewed-delete-on-merge")
	}

	if codeReview.GithubFields != nil {
		logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)

		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE
		nowTimestamp := time.Now().Unix()
		codeReview.LastChangedTimestamp = nowTimestamp
		codeReview.BringBackToReviewIfNotMergedUntilTimestamp = nowTimestamp + 3600*4

		logger.Info(
			"Marked GitHub PR as reviewed-delete-on-merge")
	} else {
		return nil, errors.Wrap(err, "only GitHub PRs supported in ReviewedDeleteOnMerge until now")
	}

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store reviewed code review")
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) SnoozeUntilMentioned(ctx context.Context, cmd *proto.SnoozeUntilMentionedCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("SnoozeUntilMentioned")

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to snooze it until mentioned")
	}

	if codeReview.GithubFields != nil {
		logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)

		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED
		codeReview.LastChangedTimestamp = time.Now().Unix()

		logger.Info(
			"Snoozed GitHub PR until mentioned")
	} else {
		return nil, errors.Wrap(err, "only GitHub PRs supported in SnoozeUntilMentioned until now")
	}

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store snoozed code review")
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) SnoozeUntilTime(ctx context.Context, cmd *proto.SnoozeUntilTimeCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId, "snoozeUntilTimestamp", cmd.SnoozeUntilTimestamp)
	logger.Info("SnoozeUntilTime")

	if cmd.SnoozeUntilTimestamp <= 0 {
		return nil, errors.New("SnoozeUntilTimeCommand.snooze_until_timestamp must be positive")
	}
	if cmd.SnoozeUntilTimestamp <= time.Now().Unix()+60 {
		return nil, errors.New("SnoozeUntilTimeCommand.snooze_until_timestamp must be farther in the future")
	}

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to snooze it until time")
	}

	if codeReview.GithubFields != nil {
		logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)

		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME
		codeReview.LastChangedTimestamp = time.Now().Unix()
		codeReview.SnoozeUntilTimestamp = cmd.SnoozeUntilTimestamp

		logger.Info(
			"Snoozed GitHub PR until time")
	} else {
		return nil, errors.Wrap(err, "only GitHub PRs supported in SnoozeUntilTime until now")
	}

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store snoozed code review")
	}

	return &proto.CommandResponse{}, nil
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
