package api

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/go-github/v63/github"
	"github.com/pkg/errors"
	"github.com/shurcooL/githubv4"
	"go.uber.org/zap"
	"golang.org/x/oauth2"

	"andidog.de/workboard/server/database"
	"andidog.de/workboard/server/proto"
)

const deleteAfterNowSeconds = 86400 * 30

type WorkboardServer struct {
	proto.UnimplementedWorkboardServer

	db      *database.Database
	dbMutex sync.Mutex
	logger  *zap.SugaredLogger

	gitHubClient        *github.Client
	gitHubGraphQLClient *githubv4.Client
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
func convertGitHubToWorkboardCodeReview(issue *github.Issue, owner string, repo string, getCodeReviewById func(codeReviewId string) (*proto.CodeReview, error), gitHubUserSelf string, gitHubMentionTriggers []string, extraInfo ExtraInfoGraphQLQuery, logger *zap.SugaredLogger) (*proto.CodeReview, error) {
	id := getWorkboardCodeReviewIdFromGitHubIssue(issue)

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

	now := time.Now()
	nowTimestamp := now.Unix()

	var updatedAtTimestamp int64 = 0
	if issue.UpdatedAt != nil {
		updatedAtTimestamp = issue.UpdatedAt.Unix()
	}

	repoIsArchived := extraInfo.Repository.ArchivedAt != nil && !extraInfo.Repository.ArchivedAt.IsZero()

	statusCheckRollupQueryState := ""
	if len(extraInfo.Repository.PullRequest.Commits.Nodes) > 0 {
		statusCheckRollupQueryState = extraInfo.Repository.PullRequest.Commits.Nodes[0].Commit.StatusCheckRollup.State
	}

	authorName := ""
	if issue.User != nil && issue.User.Login != nil {
		authorName = *issue.User.Login
	}
	if extraInfo.Repository.PullRequest.Author.Login != "" {
		authorName = extraInfo.Repository.PullRequest.Author.Login
	}
	if issue.User != nil && issue.User.Name != nil {
		authorName = *issue.User.Name
	}

	var lastMentionedAt *githubv4.DateTime
	for _, comment := range extraInfo.Repository.PullRequest.Comments.Nodes {
		for _, trigger := range gitHubMentionTriggers {
			if strings.Contains(comment.Body, trigger) {
				commentTime := comment.CreatedAt
				if comment.UpdatedAt != nil {
					commentTime = comment.UpdatedAt
				}
				if lastMentionedAt == nil || commentTime.After(lastMentionedAt.Time) {
					lastMentionedAt = commentTime
				}
			}
		}
	}

	if lastMentionedAt != nil {
		if now.Sub(lastMentionedAt.Time) > 14*24*time.Hour &&
			gitHubPullRequestStatus != proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_OPEN {
			// PR is closed/merged and the last mention comment is too long ago. This means we may be importing/seeing
			// this PR for the first time, but don't want it to show on top of the list in the "hey, look at me!"
			// eye-catching status "mentioned".
			lastMentionedAt = nil
		}
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
			Status:                  gitHubPullRequestStatus,
			StatusCheckRollupStatus: statusCheckRollupQueryState,
			IsDraft:                 extraInfo.Repository.PullRequest.IsDraft,
			UpdatedAtTimestamp:      updatedAtTimestamp,
			WillAutoMerge:           extraInfo.Repository.PullRequest.AutoMergeRequest.EnabledAt != nil,
		},

		// TODO Rather only fill these at render time, which was the purpose of the field
		RenderOnlyFields: &proto.CodeReviewRenderOnlyFields{
			AuthorIsSelf: issue.User != nil && issue.User.Login != nil && *issue.User.Login == gitHubUserSelf,
			AuthorName:   authorName,
			AvatarUrl:    conditionalUserAvatarUrl(&extraInfo, logger),
		},

		LastChangedTimestamp:                       0,
		LastRefreshedTimestamp:                     nowTimestamp,
		LastUpdatedTimestamp:                       updatedAtTimestamp,
		LastVisitedTimestamp:                       0,
		SnoozeUntilUpdatedAtChangedFrom:            0,
		BringBackToReviewIfNotMergedUntilTimestamp: 0,
		SnoozeUntilTimestamp:                       0,
	}
	existingCodeReview, err := getCodeReviewById(id)
	if err != nil {
		return nil, err
	}
	if existingCodeReview == nil {
		codeReview.LastChangedTimestamp = issue.UpdatedAt.Unix()

		return codeReview, nil
	}

	if existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_UNSPECIFIED {
		codeReview.Status = existingCodeReview.Status
	}
	codeReview.LastChangedTimestamp = max(existingCodeReview.LastChangedTimestamp, codeReview.LastChangedTimestamp)
	codeReview.LastMentionTimestamp = max(existingCodeReview.LastMentionTimestamp, codeReview.LastMentionTimestamp)
	codeReview.LastRefreshedTimestamp = max(existingCodeReview.LastRefreshedTimestamp, codeReview.LastRefreshedTimestamp)
	codeReview.LastVisitedTimestamp = max(existingCodeReview.LastVisitedTimestamp, codeReview.LastVisitedTimestamp)

	codeReview.SnoozeUntilUpdatedAtChangedFrom = existingCodeReview.SnoozeUntilUpdatedAtChangedFrom
	codeReview.BringBackToReviewIfNotMergedUntilTimestamp = existingCodeReview.BringBackToReviewIfNotMergedUntilTimestamp
	codeReview.SnoozeUntilTimestamp = existingCodeReview.SnoozeUntilTimestamp

	//
	// State machine, the smart part of the application :)
	//

	if existingCodeReview.Status == proto.CodeReviewStatus_CODE_REVIEW_STATUS_DELETED {
		return codeReview, nil
	}

	updateLastChangedToNow := false

	// A mention is considered important even after a code review is closed, for example if something was forgotten.
	// Leaving the other person's comment unanswered would be rude, so we even bring back the code review to the
	// list if it was already deleted. Or in short: the `Status` doesn't matter. Only if the repo is archived, we don't
	// care about mentions (new comments shouldn't be possible in archived GitHub repos anyway).
	if lastMentionedAt != nil && lastMentionedAt.Unix() > existingCodeReview.LastMentionTimestamp && !repoIsArchived {
		logger.Infow("Marking code review as mentioned", "existingLastMentionTimestamp", existingCodeReview.LastMentionTimestamp, "lastMentionedAt", lastMentionedAt.Unix())
		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_MENTIONED
		codeReview.LastMentionTimestamp = lastMentionedAt.Unix()
		codeReview.DeleteAfterTimestamp = 0
		updateLastChangedToNow = true
	}

	if existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_MERGED &&
		existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_MENTIONED &&
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

	if existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_CLOSED &&
		existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_MENTIONED &&
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

	if repoIsArchived && existingCodeReview.Status != proto.CodeReviewStatus_CODE_REVIEW_STATUS_ARCHIVED {
		logger.Infow("Repo became archived, marking PR as archived")
		codeReview.Status = proto.CodeReviewStatus_CODE_REVIEW_STATUS_ARCHIVED
		updateLastChangedToNow = true
	}

	if updateLastChangedToNow {
		codeReview.LastChangedTimestamp = nowTimestamp
	}

	return codeReview, nil
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

func getWorkboardCodeReviewIdFromGitHubIssue(issue *github.Issue) string {
	return *issue.HTMLURL // PR URL doesn't change and is unique, so use it as ID
}

func paginateGitHubResults(perPage int, callback func(listOptions *github.ListOptions) (*github.Response, error)) error {
	if perPage <= 0 {
		panic("Logic error (perPage)")
	}

	listOptions := github.ListOptions{
		PerPage: perPage,
	}

	for {
		res, err := callback(&listOptions)

		if err != nil {
			return err
		}

		if res.NextPage == 0 {
			return nil
		}

		listOptions.Page = res.NextPage
	}
}

func sugarLoggerWithGitHubPullRequestFields(logger *zap.SugaredLogger, gitHubFields *proto.GitHubPullRequestFields) *zap.SugaredLogger {
	return logger.With("gitHubPullRequestUrl", gitHubFields.Url)
}

func githubUserAvatarUrlDatabaseKey(login string) string {
	return fmt.Sprintf("github_user_avatar_url.%s", login)
}

// conditionalUserAvatarUrl returns the avatar URL, or empty string if none given, an error happened or it should not
// be used (untrusted domain, autogenerated block image)
func conditionalUserAvatarUrl(extraInfo *ExtraInfoGraphQLQuery, logger *zap.SugaredLogger) string {
	logger = logger.With("gitHubUserLogin", extraInfo.Repository.PullRequest.Author.Login)

	if extraInfo.Repository.PullRequest.Author.Login == "" {
		logger.Error("No avatar URL user (logic error?)")
		return ""
	}
	if extraInfo.Repository.PullRequest.Author.AvatarUrl == nil ||
		!extraInfo.Repository.PullRequest.Author.AvatarUrl.IsAbs() {
		logger.Debug("No avatar URL")
		return ""
	}

	avatarUrl := extraInfo.Repository.PullRequest.Author.AvatarUrl.String()
	logger = logger.With("avatarUrl", avatarUrl)

	if strings.HasPrefix(avatarUrl, "https://avatars.githubusercontent.com/in/") {
		// GitHub automatically creates block-shaped avatars. They don't provide much meaning, so we don't clutter
		// the code reviews listing with them.
		logger.Debug("Avatar URL is auto-generated, not storing it")
		return ""
	}

	if !strings.HasPrefix(avatarUrl, "https://avatars.githubusercontent.com/u/") {
		logger.Debug("Untrusted avatar URL")
		return ""
	}

	return avatarUrl
}

func (s *WorkboardServer) DeleteReview(ctx context.Context, cmd *proto.DeleteReviewCommand) (*proto.CommandResponse, error) {
	logger := s.logger
	logger.Info("DeleteReview")

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		logger.Errorw("Failed to get code review in order to delete it", "err", err)
		return nil, errors.Wrap(err, "failed to get code review in order to delete it")
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
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

func (s *WorkboardServer) ensureGitHubClient() (*github.Client, *githubv4.Client, error) {
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

	if s.gitHubGraphQLClient == nil {
		gitHubToken := os.Getenv("WORKBOARD_GITHUB_TOKEN")
		if gitHubToken == "" {
			return nil, nil, errors.New("failed to create GitHub GraphQL API client because it requires a token, please set environment variable WORKBOARD_GITHUB_TOKEN")
		}

		src := oauth2.StaticTokenSource(
			&oauth2.Token{AccessToken: gitHubToken},
		)
		httpClient := oauth2.NewClient(context.Background(), src)

		s.gitHubGraphQLClient = githubv4.NewClient(httpClient)
	}

	return s.gitHubClient, s.gitHubGraphQLClient, nil
}

type ExtraInfoGraphQLQuery struct {
	Repository struct {
		ArchivedAt *githubv4.DateTime

		// https://docs.github.com/en/graphql/reference/objects#pullrequest
		PullRequest struct {
			// https://docs.github.com/en/graphql/reference/interfaces#actor
			Author struct {
				AvatarUrl *githubv4.URI
				Login     string
			}

			AutoMergeRequest struct {
				EnabledAt *githubv4.DateTime
			}

			Comments struct {
				Nodes []struct {
					CreatedAt *githubv4.DateTime
					UpdatedAt *githubv4.DateTime
					Body      string
				}
			} `graphql:"comments(last: 20)"`

			Commits struct {
				Nodes []struct {
					Commit struct {
						StatusCheckRollup struct {
							State string
						}
					}
				}
			} `graphql:"commits(last: 1)"`

			IsDraft bool
		} `graphql:"pullRequest(number: $number)"`
	} `graphql:"repository(owner: $owner, name: $name)"`
}

func (s *WorkboardServer) fetchGitHubPullRequestDetails(ctx context.Context, issue *github.Issue, getCodeReviewById func(codeReviewId string) (*proto.CodeReview, error), gitHubUser string, gitHubMentionTriggers []string, logger *zap.SugaredLogger) (*proto.CodeReview, error) {
	owner, repo, err := getOwnerAndRepoFromGitHubIssue(issue, logger)
	if err != nil {
		return nil, err
	}

	_, graphQLClient, err := s.ensureGitHubClient()
	if err != nil {
		return nil, err
	}

	var extraInfo ExtraInfoGraphQLQuery
	graphQLContext, cancelGraphQLContext := context.WithTimeout(ctx, 10*time.Second)
	defer cancelGraphQLContext()
	err = graphQLClient.Query(graphQLContext, &extraInfo, map[string]interface{}{
		"owner": githubv4.String(owner),
		"name":  githubv4.String(repo),

		// `githubv4` only supports int32, so this could overflow. Likely not
		// problematic since PR numbers are per-repo and don't grow that much.
		//nolint:gosec
		"number": githubv4.Int(*issue.Number),
	})
	if err != nil {
		return nil, err
	}

	// We're storing the avatar URL per code review (another way of storage was never implemented, so the database
	// key is obsolete)
	err = s.db.Delete(githubUserAvatarUrlDatabaseKey(extraInfo.Repository.PullRequest.Author.Login))
	if err != nil {
		logger.Warnw("Failed to delete obsolete avatar URL from database", "err", err)
	}

	codeReview, err := convertGitHubToWorkboardCodeReview(issue, owner, repo, getCodeReviewById, gitHubUser, gitHubMentionTriggers, extraInfo, logger)
	if err != nil {
		return nil, err
	}
	return codeReview, nil
}

func (s *WorkboardServer) getGitHubMentionTriggers() ([]string, error) {
	logger := s.logger
	logger.Debug("Reading GitHub mention triggers from database")

	var gitHubMentionTriggers []string
	ok, err := s.db.Get("github_mention_triggers", &gitHubMentionTriggers)
	if err != nil {
		logger.Errorw("Failed to read GitHub mention triggers from database", "err", err)
		return nil, err
	}
	if !ok || len(gitHubMentionTriggers) == 0 {
		gitHubMentionTriggersStr := os.Getenv("TEST_GITHUB_MENTION_TRIGGERS")
		if gitHubMentionTriggersStr == "" {
			return nil, errors.New("GitHub mention triggers not configured (at least one must be specified)")
		}

		gitHubMentionTriggers := strings.Split(gitHubMentionTriggersStr, ",")
		for _, trigger := range gitHubMentionTriggers {
			if !strings.HasPrefix(trigger, "@") {
				return nil, fmt.Errorf("GitHub mention triggers must be comma-separated and each start with `@`: %q", trigger)
			}

			trimmedTrigger := strings.TrimSpace(trigger)
			if trimmedTrigger == "" || trimmedTrigger != trigger {
				return nil, fmt.Errorf("GitHub mention triggers may not contain spaces or be empty: %q", trigger)
			}
		}

		err = s.db.Set("github_mention_triggers", gitHubMentionTriggers)
		if err != nil {
			logger.Errorw("Failed to write test GitHub mention triggers into database", "err", err)
			return nil, err
		}
	}
	logger.Debugw("Found GitHub mention triggers in database", "gitHubMentionTriggers", gitHubMentionTriggers)
	return gitHubMentionTriggers, nil
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
	if !ok || gitHubUser == "" {
		gitHubUser = os.Getenv("TEST_GITHUB_USER")
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

// getCodeReviewById returns the code review by ID, or nil if none exists with that ID.
// The caller is responsible for locking `dbMutex`.
func (s *WorkboardServer) getCodeReviewById(codeReviewId string) (*proto.CodeReview, error) {
	codeReviews, err := s.getCodeReviews()
	if err != nil {
		return nil, err
	}

	return codeReviews[codeReviewId], nil
}

// getCodeReviews reads the list of code reviews from the database.
// The caller is responsible for locking `dbMutex`.
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

func (s *WorkboardServer) relistCodeReviews(ctx context.Context) error {
	logger := s.logger

	gitHubUser, err := s.getGitHubUser()
	if err != nil {
		return err
	}
	logger = logger.With("gitHubUser", gitHubUser)

	gitHubMentionTriggers, err := s.getGitHubMentionTriggers()
	if err != nil {
		return err
	}
	logger = logger.With("gitHubMentionTriggers", gitHubMentionTriggers)

	logger.Info("Relisting code reviews")

	client, _, err := s.ensureGitHubClient()
	if err != nil {
		return err
	}

	alreadyUpdatedGithubPrUrls := map[string]bool{}

	for _, query := range []string{
		// Own PRs
		fmt.Sprintf(`author:"%s" is:pr is:open archived:false`, gitHubUser),
		// Assigned PRs
		fmt.Sprintf(`assignee:"%s" is:pr is:open archived:false`, gitHubUser),
		// Reviewed-requested PRs
		fmt.Sprintf(`review-requested:"%s" is:pr is:open archived:false`, gitHubUser),
		// Reviewed-by PRs
		fmt.Sprintf(`reviewed-by:"%s" is:pr is:open archived:false`, gitHubUser),
	} {
		logger = logger.With("query", query)
		logger.Debug("Querying GitHub PRs")

		var issues []*github.Issue
		perPage := 1000
		err = paginateGitHubResults(perPage, func(listOptions *github.ListOptions) (*github.Response, error) {
			logger.Debug("Querying next GitHub PRs page")
			issuesRes, gitHubRes, err := client.Search.Issues(ctx, query, &github.SearchOptions{
				// Idempotent order
				Sort:        "created",
				Order:       "desc",
				ListOptions: *listOptions,
			})

			if err != nil {
				return nil, err
			}

			issues = append(issues, issuesRes.Issues...)

			return gitHubRes, nil
		})
		logger.Debug("Queried GitHub PRs")
		if err != nil {
			return errors.Wrapf(err, "failed to search GitHub PRs for user %q", gitHubUser)
		}

		for _, issue := range issues {
			if _, ok := alreadyUpdatedGithubPrUrls[*issue.HTMLURL]; ok {
				continue
			}
			alreadyUpdatedGithubPrUrls[*issue.HTMLURL] = true

			// Only fetch code reviews which aren't known yet. For the existing reviews,
			// the UI should perform single refreshes in batches since that keeps the UI
			// responsive instead of taking minutes to display anything and hammering the
			// GitHub API and others.
			codeReviewId := getWorkboardCodeReviewIdFromGitHubIssue(issue)
			// No lock needed here since we want to check only existence
			var existingCodeReview *proto.CodeReview
			existingCodeReview, err = s.getCodeReviewById(codeReviewId)
			if err != nil {
				break
			}
			if existingCodeReview != nil {
				logger.Debug("Skipping already-known PR in relisting")
				continue
			}

			logger := logger.With("url", *issue.HTMLURL)
			logger.Debug("Fetching details for not-yet-known GitHub PR")
			var codeReview *proto.CodeReview
			codeReview, err = s.fetchGitHubPullRequestDetails(ctx, issue, s.getCodeReviewById, gitHubUser, gitHubMentionTriggers, logger)
			if err != nil {
				return errors.Wrap(err, "failed to fetch GitHub PR details for relist")
			}
			logger.Debug("Fetched details for not-yet-known GitHub PR")

			logger.Debug("Storing code review")
			s.dbMutex.Lock()
			err = s.storeCodeReview(codeReview)
			s.dbMutex.Unlock()

			if err != nil {
				return errors.Wrap(err, "failed to store GitHub PR details from relist")
			}
		}
	}

	logger.Info("Relisted code reviews")
	return nil
}

// storeCodeReview stores the code review in the database.
// The caller is responsible for locking `dbMutex`.
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

	// Don't wait for database lock so the UI stays reactive

	codeReviews, err := s.getCodeReviews()
	if err != nil {
		logger.Errorw("Failed to get code reviews", "err", err)
		return nil, err
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

	codeReview, err := s.getCodeReviewById(codeReviewId) // variable gets updated below
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

	gitHubMentionTriggers, err := s.getGitHubMentionTriggers()
	if err != nil {
		return nil, err
	}
	logger = logger.With("gitHubMentionTriggers", gitHubMentionTriggers)

	client, _, err := s.ensureGitHubClient()
	if err != nil {
		return nil, err
	}
	logger.Debug("Querying GitHub PR")
	issue, _, err := client.Issues.Get(ctx, codeReview.GithubFields.Repo.OrganizationName, codeReview.GithubFields.Repo.Name, int(codeReview.GithubFields.Number))
	logger.Debug("Queried GitHub PR")
	if err != nil {
		return nil, errors.Wrap(err, "failed to get GitHub PR")
	}

	codeReview, err = s.fetchGitHubPullRequestDetails(ctx, issue, s.getCodeReviewById, gitHubUser, gitHubMentionTriggers, logger)
	if err != nil {
		return nil, errors.Wrap(err, "failed to fetch GitHub PR details")
	}
	logger.Debug("Queried details for GitHub PR")

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	logger.Debug("Storing details for GitHub PR")
	if err := s.storeCodeReview(codeReview); err != nil {
		return nil, err
	}

	return codeReview, nil
}

func (s *WorkboardServer) MarkMustReview(ctx context.Context, cmd *proto.MarkMustReviewCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("MarkMustReview")

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to mark it must-review")
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
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

func (s *WorkboardServer) MarkVisited(ctx context.Context, cmd *proto.MarkVisitedCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("MarkVisited")

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to mark it visited")
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
	}

	if codeReview.GithubFields != nil {
		logger = sugarLoggerWithGitHubPullRequestFields(logger, codeReview.GithubFields)
	}

	codeReview.LastVisitedTimestamp = time.Now().Unix()

	logger.Info(
		"Marked code review as visited")

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store visited code review")
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) RelistReviews(ctx context.Context, query *proto.RelistReviewsCommand) (*proto.CommandResponse, error) {
	logger := s.logger
	logger.Info("RelistReviews")

	// Not used anymore
	err := s.db.Delete("last_code_reviews_refresh")
	if err != nil {
		logger.Warnw("Failed to delete deprecated database key", "err", err)
	}

	err = s.relistCodeReviews(ctx)
	if err != nil {
		logger.Errorw("Failed to refresh code reviews", "err", err)
		return nil, err
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) RefreshReview(ctx context.Context, cmd *proto.RefreshReviewCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("RefreshReview")

	_, err := s.refreshCodeReview(ctx, cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to refresh code review")
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) RefreshReviews(ctx context.Context, cmd *proto.RefreshReviewsCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewIds", cmd.CodeReviewIds)
	logger.Info("RefreshReviews")

	if len(cmd.CodeReviewIds) <= 0 {
		return nil, errors.New("RefreshReviewsCommand.code_review_ids must not be empty")
	}
	const maxNumReviews = 20
	if len(cmd.CodeReviewIds) > maxNumReviews {
		return nil, errors.Errorf("RefreshReviewsCommand.code_review_ids only allows %d reviews at once", maxNumReviews)
	}

	for _, codeReviewId := range cmd.CodeReviewIds {
		_, err := s.refreshCodeReview(ctx, codeReviewId)
		if err != nil {
			return nil, errors.Wrap(err, "failed to refresh code review")
		}
	}

	return &proto.CommandResponse{}, nil
}

func (s *WorkboardServer) ReviewedDeleteOnMerge(ctx context.Context, cmd *proto.ReviewedDeleteOnMergeCommand) (*proto.CommandResponse, error) {
	logger := s.logger.With("codeReviewId", cmd.CodeReviewId)
	logger.Info("ReviewedDeleteOnMerge")

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to mark it reviewed-delete-on-merge")
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
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

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to snooze it until mentioned")
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
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

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	codeReview, err := s.getCodeReviewById(cmd.CodeReviewId)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code review in order to snooze it until time")
	}
	if codeReview == nil {
		return nil, errors.New("no such code review")
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

	s.dbMutex.Lock()
	defer s.dbMutex.Unlock()

	err = s.storeCodeReview(codeReview)
	if err != nil {
		return nil, errors.Wrap(err, "failed to store snoozed code review")
	}

	return &proto.CommandResponse{}, nil
}
