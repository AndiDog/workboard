package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/google/go-github/v63/github"
	"github.com/pkg/errors"
	"github.com/shurcooL/githubv4"
	"go.uber.org/zap"

	"andidog.de/workboard/server/proto"
)

const defaultGitHubNotificationsPollInterval = 60 * time.Second

// Computing CI status and comments is expensive for GitHub, so larger queries get close to GitHub's 10 second timeout
const detailsQueryChunkSize = 25

// GitHub charges the minimum of 1 point for queries of up to 99 pull requests. Smaller chunks run in parallel and
// therefore finish faster.
const fingerprintQueryChunkSize = 50

const gitHubNotificationsLastModifiedDatabaseKey = "github_notifications_last_modified"

const gitHubNotificationsPerPage = 50

// Notifications updated slightly before the previous `Last-Modified` value may not have been seen yet
const gitHubNotificationsSinceMargin = 10 * time.Minute

// Without a previous `Last-Modified` value (first run), recent notifications may still matter
const initialGitHubNotificationsLookback = 24 * time.Hour

// Changed pull requests beyond this number get fetched by the next poll
const maxChangedFullFetchesPerPoll = 50

// Each backfill costs one REST and one GraphQL request, so only a few should happen per poll
const maxNodeIdBackfillsPerPoll = 10

const maxParallelDetailsQueries = 2

const maxParallelFingerprintQueries = 4

const maxSafetyNetFullFetchesPerPoll = 10

// Multiple browser tabs, or a tab becoming visible again, should not lead to more GitHub API requests
const minChangedReviewsPollInterval = 25 * time.Second

// Below this share of the rate limit, polls are spread out until the limit resets
const rateLimitReserveFraction = 0.2

// Fingerprints miss some changes (e.g. edited comments, archived repo), so refresh fully after this age
const safetyNetMaxAgeClosed = 24 * time.Hour

const safetyNetMaxAgeOpen = 6 * time.Hour

var gitHubNotificationReasonsAddingUnknownPullRequests = []string{
	"assign",
	"author",
	"mention",
	"review_requested",
	"team_mention",
}

var gitHubPullRequestApiUrlRe = regexp.MustCompile(`^https://api\.github\.com/repos/([^/]+)/([^/]+)/pulls/([1-9][0-9]*)$`)

type gitHubGraphQLRateLimit struct {
	Cost      int
	Limit     int
	Remaining int
	ResetAt   githubv4.DateTime
}

type gitHubNotificationPullRequest struct {
	number int
	owner  string
	repo   string
}

type gitHubPullRequestDetailsGraphQLQuery struct {
	RateLimit gitHubGraphQLRateLimit

	Nodes []struct {
		PullRequest GitHubPullRequestGraphQLFields `graphql:"... on PullRequest"`
	} `graphql:"nodes(ids: $ids)"`
}

// gitHubPullRequestFingerprintGraphQLQuery must only contain fields which `gitHubPullRequestFingerprint` uses
type gitHubPullRequestFingerprintGraphQLQuery struct {
	RateLimit gitHubGraphQLRateLimit

	Nodes []struct {
		PullRequest struct {
			Commits    GitHubLastCommitGraphQLFields `graphql:"commits(last: 1)"`
			HeadRefOid string
			Id         string
			State      string
			UpdatedAt  githubv4.DateTime
		} `graphql:"... on PullRequest"`
	} `graphql:"nodes(ids: $ids)"`
}

// forEachChunkInParallel calls `callback` for each chunk of `ids`, with at most `parallelism` calls running at once
func forEachChunkInParallel(ids []string, chunkSize int, parallelism int, callback func(chunk []string)) {
	semaphore := make(chan struct{}, parallelism)
	var waitGroup sync.WaitGroup
	for start := 0; start < len(ids); start += chunkSize {
		chunk := ids[start:min(start+chunkSize, len(ids))]
		waitGroup.Add(1)
		semaphore <- struct{}{}
		go func() {
			defer waitGroup.Done()
			defer func() { <-semaphore }()
			callback(chunk)
		}()
	}
	waitGroup.Wait()
}

func gitHubIssueFromGraphQLPullRequest(pullRequest *GitHubPullRequestGraphQLFields) *github.Issue {
	state := gitHubIssueStateOpen
	if pullRequest.State != "OPEN" {
		state = gitHubIssueStateClosed
	}

	ret := &github.Issue{
		HTMLURL:          github.String(pullRequest.Url),
		Number:           github.Int(pullRequest.Number),
		PullRequestLinks: &github.PullRequestLinks{},
		State:            &state,
		Title:            github.String(pullRequest.Title),
		UpdatedAt:        &github.Timestamp{Time: pullRequest.UpdatedAt.Time},
		User:             &github.User{Login: github.String(pullRequest.Author.Login)},
	}
	if pullRequest.MergedAt != nil {
		ret.PullRequestLinks.MergedAt = &github.Timestamp{Time: pullRequest.MergedAt.Time}
	}
	return ret
}

// gitHubPullRequestFingerprint changes whenever the pull request changes in a way relevant to workboard. CI status is
// included since its changes don't touch `updatedAt`.
func gitHubPullRequestFingerprint(updatedAt githubv4.DateTime, state string, headRefOid string, statusCheckRollupState string) string {
	return fmt.Sprintf("%d|%s|%s|%s", updatedAt.Unix(), state, headRefOid, statusCheckRollupState)
}

func toGitHubGraphQLIds(nodeIds []string) []githubv4.ID {
	var ret []githubv4.ID
	for _, nodeId := range nodeIds {
		ret = append(ret, githubv4.ID(nodeId))
	}
	return ret
}

// changedReviewsMinPollInterval spreads out polls if few GitHub GraphQL API points remain until the rate limit
// resets. The caller is responsible for locking `changedReviewsPollMutex`.
func (s *WorkboardServer) changedReviewsMinPollInterval(now time.Time) time.Duration {
	ret := minChangedReviewsPollInterval

	rateLimit := s.gitHubGraphQLRateLimit
	untilReset := rateLimit.ResetAt.Sub(now)
	if rateLimit.Limit == 0 || untilReset <= 0 ||
		float64(rateLimit.Remaining) >= rateLimitReserveFraction*float64(rateLimit.Limit) {
		return ret
	}

	throttledPollInterval := untilReset
	affordablePolls := rateLimit.Remaining / max(1, s.lastChangedReviewsPollCost)
	if affordablePolls > 0 {
		throttledPollInterval = untilReset / time.Duration(affordablePolls)
	}

	if throttledPollInterval > ret {
		ret = throttledPollInterval

		if !s.gitHubGraphQLRateLimitWarnedResetAt.Equal(rateLimit.ResetAt.Time) {
			s.gitHubGraphQLRateLimitWarnedResetAt = rateLimit.ResetAt.Time
			s.logger.Warnw("Few GitHub GraphQL API rate limit points remaining, polling less often until reset",
				"remaining", rateLimit.Remaining,
				"limit", rateLimit.Limit,
				"resetAt", rateLimit.ResetAt.Time,
				"pollInterval", ret)
		}
	}

	return ret
}

// fetchGitHubPullRequestFingerprints returns the fingerprint per node ID. Pull requests which couldn't be queried are
// left out and therefore treated as unchanged.
func (s *WorkboardServer) fetchGitHubPullRequestFingerprints(ctx context.Context, graphQLClient *githubv4.Client, nodeIds []string, logger *zap.SugaredLogger) (map[string]string, []gitHubGraphQLRateLimit, error) {
	var mutex sync.Mutex
	nodeIdToFingerprint := map[string]string{}
	var rateLimits []gitHubGraphQLRateLimit
	numFailedChunks := 0
	numChunks := 0

	forEachChunkInParallel(nodeIds, fingerprintQueryChunkSize, maxParallelFingerprintQueries, func(chunk []string) {
		var query gitHubPullRequestFingerprintGraphQLQuery
		queryContext, cancelQueryContext := context.WithTimeout(ctx, 10*time.Second)
		defer cancelQueryContext()
		err := graphQLClient.Query(queryContext, &query, map[string]interface{}{
			"ids": toGitHubGraphQLIds(chunk),
		})

		mutex.Lock()
		defer mutex.Unlock()

		numChunks++
		if err != nil && len(query.Nodes) == 0 {
			numFailedChunks++
			logger.Errorw("Failed to query GitHub PR fingerprints", "err", err)
			return
		}
		if err != nil {
			// The `githubv4` library returns partial errors (e.g. no access to a node) but still fills the data
			logger.Warnw("Partially failed to query GitHub PR fingerprints", "err", err)
		}

		rateLimits = append(rateLimits, query.RateLimit)
		for i, node := range query.Nodes {
			if node.PullRequest.Id == "" {
				logger.Warnw("GitHub PR not found by node ID, skipping it", "nodeId", chunk[i])
				continue
			}
			nodeIdToFingerprint[node.PullRequest.Id] = gitHubPullRequestFingerprint(
				node.PullRequest.UpdatedAt,
				node.PullRequest.State,
				node.PullRequest.HeadRefOid,
				node.PullRequest.Commits.statusCheckRollupState())
		}
	})

	if numChunks > 0 && numFailedChunks == numChunks {
		return nil, rateLimits, errors.New("failed to query any GitHub PR fingerprints")
	}

	return nodeIdToFingerprint, rateLimits, nil
}

// fetchGitHubPullRequestsByNodeIds returns the details of all pull requests which could be queried
func (s *WorkboardServer) fetchGitHubPullRequestsByNodeIds(ctx context.Context, graphQLClient *githubv4.Client, nodeIds []string, logger *zap.SugaredLogger) ([]*GitHubPullRequestGraphQLFields, []gitHubGraphQLRateLimit) {
	var mutex sync.Mutex
	var ret []*GitHubPullRequestGraphQLFields
	var rateLimits []gitHubGraphQLRateLimit

	forEachChunkInParallel(nodeIds, detailsQueryChunkSize, maxParallelDetailsQueries, func(chunk []string) {
		var query gitHubPullRequestDetailsGraphQLQuery
		queryContext, cancelQueryContext := context.WithTimeout(ctx, 10*time.Second)
		defer cancelQueryContext()
		err := graphQLClient.Query(queryContext, &query, map[string]interface{}{
			"ids": toGitHubGraphQLIds(chunk),
		})

		mutex.Lock()
		defer mutex.Unlock()

		if err != nil && len(query.Nodes) == 0 {
			logger.Errorw("Failed to query GitHub PR details", "err", err)
			return
		}
		if err != nil {
			logger.Warnw("Partially failed to query GitHub PR details", "err", err)
		}

		rateLimits = append(rateLimits, query.RateLimit)
		for i := range query.Nodes {
			if query.Nodes[i].PullRequest.Id == "" {
				logger.Warnw("GitHub PR not found by node ID, skipping it", "nodeId", chunk[i])
				continue
			}
			ret = append(ret, &query.Nodes[i].PullRequest)
		}
	})

	return ret, rateLimits
}

// observeGitHubGraphQLRateLimits remembers the lowest remaining rate limit. The caller is responsible for locking
// `changedReviewsPollMutex`.
func (s *WorkboardServer) observeGitHubGraphQLRateLimits(rateLimits []gitHubGraphQLRateLimit) {
	for _, rateLimit := range rateLimits {
		s.logger.Debugw("GitHub GraphQL API rate limit", "cost", rateLimit.Cost, "remaining", rateLimit.Remaining, "limit", rateLimit.Limit, "resetAt", rateLimit.ResetAt.Time)

		if rateLimit.Limit == 0 {
			continue
		}
		if s.gitHubGraphQLRateLimit.ResetAt.Before(rateLimit.ResetAt.Time) || rateLimit.Remaining < s.gitHubGraphQLRateLimit.Remaining {
			s.gitHubGraphQLRateLimit = rateLimit
		}
	}
}

// pollGitHubNotificationsForUnknownPullRequests returns not-yet-known pull requests from notifications which are
// relevant to the user (e.g. review requests including those for teams, or mentions)
func (s *WorkboardServer) pollGitHubNotificationsForUnknownPullRequests(ctx context.Context, client *github.Client, logger *zap.SugaredLogger) ([]gitHubNotificationPullRequest, error) {
	now := time.Now()
	if now.Before(s.nextGitHubNotificationsPollTime) {
		logger.Debug("Not polling GitHub notifications yet because of their poll interval")
		return nil, nil
	}

	var lastModified string
	_, err := s.db.Get(gitHubNotificationsLastModifiedDatabaseKey, &lastModified)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read last modified time of GitHub notifications from database")
	}

	// Keep `since` stable until notifications change, so that `If-Modified-Since` applies to the same request
	since := now.Add(-initialGitHubNotificationsLookback)
	if lastModified != "" {
		lastModifiedTime, err := http.ParseTime(lastModified)
		if err != nil {
			logger.Warnw("Failed to parse stored last modified time of GitHub notifications", "lastModified", lastModified, "err", err)
		} else {
			since = lastModifiedTime.Add(-gitHubNotificationsSinceMargin)
		}
	}

	codeReviews, err := s.getCodeReviews()
	if err != nil {
		return nil, err
	}

	var ret []gitHubNotificationPullRequest
	seenCodeReviewIds := map[string]bool{}
	pollInterval := defaultGitHubNotificationsPollInterval
	newLastModified := ""
	page := 1
	for {
		requestUrl := fmt.Sprintf("notifications?all=true&since=%s&per_page=%d&page=%d",
			url.QueryEscape(since.UTC().Format(time.RFC3339)), gitHubNotificationsPerPage, page)
		request, err := client.NewRequest(http.MethodGet, requestUrl, nil)
		if err != nil {
			return nil, err
		}
		if page == 1 && lastModified != "" {
			request.Header.Set("If-Modified-Since", lastModified)
		}

		var notifications []*github.Notification
		response, err := client.Do(ctx, request, &notifications)
		if response != nil && page == 1 {
			pollIntervalSeconds, parseErr := strconv.Atoi(response.Header.Get("X-Poll-Interval"))
			if parseErr == nil && pollIntervalSeconds > 0 {
				pollInterval = time.Duration(pollIntervalSeconds) * time.Second
			}
			newLastModified = response.Header.Get("Last-Modified")
			logger.Debugw("Queried GitHub notifications", "statusCode", response.StatusCode, "rateLimitRemaining", response.Rate.Remaining, "pollInterval", pollInterval)
		}
		if response != nil && response.StatusCode == http.StatusNotModified {
			s.nextGitHubNotificationsPollTime = now.Add(pollInterval)
			return nil, nil
		}
		if err != nil {
			return nil, errors.Wrap(err, "failed to query GitHub notifications")
		}

		for _, notification := range notifications {
			if notification.Subject == nil || notification.Subject.GetType() != "PullRequest" ||
				!slices.Contains(gitHubNotificationReasonsAddingUnknownPullRequests, notification.GetReason()) {
				continue
			}

			match := gitHubPullRequestApiUrlRe.FindStringSubmatch(notification.Subject.GetURL())
			if match == nil {
				logger.Warnw("Failed to parse GitHub PR API URL of notification", "url", notification.Subject.GetURL())
				continue
			}
			number, err := strconv.Atoi(match[3])
			if err != nil {
				logger.Warnw("Failed to parse GitHub PR number of notification", "url", notification.Subject.GetURL(), "err", err)
				continue
			}

			// Same as `getWorkboardCodeReviewIdFromGitHubIssue`
			codeReviewId := fmt.Sprintf("https://github.com/%s/%s/pull/%d", match[1], match[2], number)
			if _, ok := codeReviews[codeReviewId]; ok || seenCodeReviewIds[codeReviewId] {
				continue
			}
			seenCodeReviewIds[codeReviewId] = true

			logger.Infow("Found not-yet-known GitHub PR in notifications", "url", codeReviewId, "reason", notification.GetReason())
			ret = append(ret, gitHubNotificationPullRequest{
				number: number,
				owner:  match[1],
				repo:   match[2],
			})
		}

		if response.NextPage == 0 {
			break
		}
		page = response.NextPage
	}

	s.nextGitHubNotificationsPollTime = now.Add(pollInterval)
	if newLastModified != "" {
		err = s.db.Set(gitHubNotificationsLastModifiedDatabaseKey, newLastModified)
		if err != nil {
			return nil, errors.Wrap(err, "failed to store last modified time of GitHub notifications in database")
		}
	}

	return ret, nil
}

// refreshChangedCodeReviews returns the IDs of all code reviews which were stored. The caller is responsible for
// locking `changedReviewsPollMutex`.
func (s *WorkboardServer) refreshChangedCodeReviews(ctx context.Context, logger *zap.SugaredLogger) ([]string, error) {
	gitHubMentionTriggers, err := s.getGitHubMentionTriggers()
	if err != nil {
		return nil, err
	}

	client, graphQLClient, err := s.ensureGitHubClient()
	if err != nil {
		return nil, err
	}

	var ret []string

	newPullRequests, err := s.pollGitHubNotificationsForUnknownPullRequests(ctx, client, logger)
	if err != nil {
		// Relisting finds most of these pull requests later, so don't fail the whole poll
		logger.Errorw("Failed to poll GitHub notifications", "err", err)
	}
	for _, newPullRequest := range newPullRequests {
		logger := logger.With("owner", newPullRequest.owner, "repo", newPullRequest.repo, "number", newPullRequest.number)

		issue, _, err := client.Issues.Get(ctx, newPullRequest.owner, newPullRequest.repo, newPullRequest.number)
		if err != nil {
			logger.Errorw("Failed to get GitHub PR from notification", "err", err)
			continue
		}
		extraInfo, err := s.fetchGitHubPullRequestDetails(ctx, issue, logger)
		if err != nil {
			logger.Errorw("Failed to fetch details for GitHub PR from notification", "err", err)
			continue
		}
		codeReview, err := s.convertAndStoreCodeReview(issue, extraInfo, gitHubMentionTriggers, logger)
		if err != nil {
			logger.Errorw("Failed to store GitHub PR from notification", "err", err)
			continue
		}
		ret = append(ret, codeReview.Id)
	}

	// No lock needed since stored changes are merged under the lock
	codeReviews, err := s.getCodeReviews()
	if err != nil {
		return ret, err
	}

	nodeIdToCodeReview := map[string]*proto.CodeReview{}
	var codeReviewsWithoutNodeId []*proto.CodeReview
	for _, codeReview := range codeReviews {
		if codeReview.Status == proto.CodeReviewStatus_CODE_REVIEW_STATUS_DELETED || codeReview.GithubFields == nil {
			continue
		}
		if codeReview.GithubFields.NodeId == "" {
			codeReviewsWithoutNodeId = append(codeReviewsWithoutNodeId, codeReview)
		} else {
			nodeIdToCodeReview[codeReview.GithubFields.NodeId] = codeReview
		}
	}

	// Code reviews stored before node IDs were introduced
	slices.SortFunc(codeReviewsWithoutNodeId, func(a, b *proto.CodeReview) int {
		return int(b.LastUpdatedTimestamp - a.LastUpdatedTimestamp)
	})
	for _, codeReview := range codeReviewsWithoutNodeId[:min(maxNodeIdBackfillsPerPoll, len(codeReviewsWithoutNodeId))] {
		_, err := s.refreshCodeReview(ctx, codeReview.Id)
		if err != nil {
			logger.Errorw("Failed to refresh code review in order to store its node ID", "codeReviewId", codeReview.Id, "err", err)
			continue
		}
		ret = append(ret, codeReview.Id)
	}

	var nodeIds []string
	for nodeId := range nodeIdToCodeReview {
		nodeIds = append(nodeIds, nodeId)
	}
	slices.Sort(nodeIds)

	nodeIdToFingerprint, fingerprintRateLimits, err := s.fetchGitHubPullRequestFingerprints(ctx, graphQLClient, nodeIds, logger)
	s.observeGitHubGraphQLRateLimits(fingerprintRateLimits)
	if err != nil {
		return ret, err
	}

	var changedNodeIds []string
	for nodeId, fingerprint := range nodeIdToFingerprint {
		if fingerprint != nodeIdToCodeReview[nodeId].GithubFields.Fingerprint {
			changedNodeIds = append(changedNodeIds, nodeId)
		}
	}
	slices.SortFunc(changedNodeIds, func(a, b string) int {
		return int(nodeIdToCodeReview[b].LastUpdatedTimestamp - nodeIdToCodeReview[a].LastUpdatedTimestamp)
	})
	changedNodeIds = changedNodeIds[:min(maxChangedFullFetchesPerPoll, len(changedNodeIds))]

	nowTimestamp := time.Now().Unix()
	var safetyNetNodeIds []string
	for _, nodeId := range nodeIds {
		codeReview := nodeIdToCodeReview[nodeId]
		maxAge := safetyNetMaxAgeClosed
		if codeReview.GithubFields.Status == proto.GitHubPullRequestStatus_GITHUB_PULL_REQUEST_STATUS_OPEN {
			maxAge = safetyNetMaxAgeOpen
		}
		if nowTimestamp-codeReview.LastRefreshedTimestamp > int64(maxAge.Seconds()) && !slices.Contains(changedNodeIds, nodeId) {
			safetyNetNodeIds = append(safetyNetNodeIds, nodeId)
		}
	}
	slices.SortFunc(safetyNetNodeIds, func(a, b string) int {
		return int(nodeIdToCodeReview[a].LastRefreshedTimestamp - nodeIdToCodeReview[b].LastRefreshedTimestamp)
	})
	safetyNetNodeIds = safetyNetNodeIds[:min(maxSafetyNetFullFetchesPerPoll, len(safetyNetNodeIds))]

	logger.Infow("Polled GitHub PRs for changes",
		"numPolled", len(nodeIds),
		"numChanged", len(changedNodeIds),
		"numSafetyNet", len(safetyNetNodeIds),
		"numNodeIdBackfills", min(maxNodeIdBackfillsPerPoll, len(codeReviewsWithoutNodeId)),
		"numFromNotifications", len(newPullRequests))

	pullRequests, detailsRateLimits := s.fetchGitHubPullRequestsByNodeIds(ctx, graphQLClient, slices.Concat(changedNodeIds, safetyNetNodeIds), logger)
	s.observeGitHubGraphQLRateLimits(detailsRateLimits)
	s.lastChangedReviewsPollCost = 0
	for _, rateLimit := range slices.Concat(fingerprintRateLimits, detailsRateLimits) {
		s.lastChangedReviewsPollCost += rateLimit.Cost
	}

	for _, pullRequest := range pullRequests {
		logger := logger.With("url", pullRequest.Url)

		extraInfo := &ExtraInfoGraphQLQuery{}
		extraInfo.Repository.ArchivedAt = pullRequest.Repository.ArchivedAt
		extraInfo.Repository.PullRequest = *pullRequest

		codeReview, err := s.convertAndStoreCodeReview(gitHubIssueFromGraphQLPullRequest(pullRequest), extraInfo, gitHubMentionTriggers, logger)
		if err != nil {
			logger.Errorw("Failed to store changed GitHub PR", "err", err)
			continue
		}
		ret = append(ret, codeReview.Id)
	}

	return ret, nil
}
