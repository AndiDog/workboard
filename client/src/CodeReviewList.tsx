import { Component } from 'preact';
import SafeColor from './vendor/safecolor/safecolor';
import * as timeago from 'timeago.js';
import {
  WorkboardClient,
  GetCodeReviewsQuery,
  GetCodeReviewsResponse,
  CodeReviewStatus,
  GitHubPullRequestStatus,
  SnoozeUntilUpdateCommand,
  ReviewedDeleteOnMergeCommand,
  CommandResponse,
  SnoozeUntilMentionedCommand,
  MarkMustReviewCommand,
  SnoozeUntilTimeCommand,
  CodeReview,
  RefreshReviewCommand,
  DeleteReviewCommand,
} from './generated/workboard';
import { GrpcResult, makePendingGrpcResult, toGrpcResult } from './grpc';
import Spinner from './Spinner';
import { RpcError } from 'grpc-web';
import ErrorBanner from './ErrorBanner';

const safeColor = new SafeColor({ color: [255, 255, 255], contrast: 3 });

type CodeReviewListState = {
  codeReviewGroups?: CodeReviewGroup[];
  codeReviewsGrpcResult?: GrpcResult<GetCodeReviewsResponse>;

  codeReviewIdsWithActiveCommands: Set<string>;
};

const codeReviewStatusToStringMap: {
  [codeReviewStatus in CodeReviewStatus]: string;
} = {
  [CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED]: 'closed',
  [CodeReviewStatus.CODE_REVIEW_STATUS_DELETED]: 'deleted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_MERGED]: 'merged',
  [CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW]: 'must-review',
  [CodeReviewStatus.CODE_REVIEW_STATUS_NEW]: 'new',
  [CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE]:
    'reviewed-delete-on-merge',
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED]:
    'snoozed-until-mentioned',
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME]:
    'snoozed-until-time',
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE]:
    'snoozed-until-update',
  [CodeReviewStatus.CODE_REVIEW_STATUS_UNSPECIFIED]:
    '<codeReviewStatusToStringMap logic error: unspecified enum value>',
  [CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE]:
    'updated-after-snooze',
};

function codeReviewStatusToString(status: CodeReviewStatus): string {
  const value = codeReviewStatusToStringMap[status];
  if (value === undefined) {
    return '<codeReviewStatusToString logic error: unhandled enum value>';
  }
  return value;
}

const gitHubPullRequestStatusToStringMap: {
  [gitHubPullRequestStatus in GitHubPullRequestStatus]: string;
} = {
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED]: 'closed',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED]: 'merged',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_OPEN]: 'open',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_UNSPECIFIED]:
    '<gitHubPullRequestStatusToStringMap logic error: unspecified enum value>',
};

function gitHubPullRequestStatusToString(
  status: GitHubPullRequestStatus,
): string {
  const value = gitHubPullRequestStatusToStringMap[status];
  if (value === undefined) {
    return '<gitHubPullRequestStatusToString logic error: unhandled enum value>';
  }
  return value;
}

const statusSortOrder: {
  [codeReviewStatus in CodeReviewStatus]: number;
} = {
  // Low number = sorted to top, high number = sorted to bottom
  [CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED]: 1,
  [CodeReviewStatus.CODE_REVIEW_STATUS_DELETED]: 999, // not applicable since we filter those out for rendering
  [CodeReviewStatus.CODE_REVIEW_STATUS_MERGED]: 1,
  [CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW]: 2,
  [CodeReviewStatus.CODE_REVIEW_STATUS_NEW]: 4,
  [CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE]: 5,
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED]: 5,
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME]: 5,
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE]: 5,
  [CodeReviewStatus.CODE_REVIEW_STATUS_UNSPECIFIED]: 0, // sort to top since that would be a logic error the developer should see
  [CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE]: 1,
};

enum CodeReviewGroupType {
  // Strings in lexicographical order of display top-to-bottom.
  // The order prefix can be freely changed without having to touch other
  // places in code. The rest is used for CSS classes such as `tr.code-review-group-type-snoozed`.
  MergedOrUpdated = '100-merged-or-updated',
  MustReviewOrCameBackFromSnooze = '200-must-review',
  Rest = '700-rest',
  Reviewed = '800-reviewed',
  Snoozed = '900-snoozed',
}

const codeReviewGroupTypes: Array<CodeReviewGroupType> = Object.keys(
  CodeReviewGroupType,
).map((groupType) => {
  const key = groupType as keyof typeof CodeReviewGroupType;
  return CodeReviewGroupType[key];
});

const codeReviewGroupTypeHeaderDescription: {
  [groupType in CodeReviewGroupType]: string;
} = {
  [CodeReviewGroupType.MergedOrUpdated]: 'Merged or updated',
  [CodeReviewGroupType.MustReviewOrCameBackFromSnooze]: 'Must review',
  [CodeReviewGroupType.Rest]: 'Other',
  [CodeReviewGroupType.Reviewed]: 'Reviewed',
  [CodeReviewGroupType.Snoozed]: 'Snoozed',
};

type CodeReviewGroup = {
  groupType: CodeReviewGroupType;
  groupTypeStrWithoutOrderPrefix: string; // e.g. `must-review` (trimmed from `000-must-review`; used for CSS classes)
  sortedCodeReviews: CodeReview[];
};

function sortCodeReviews(res: GetCodeReviewsResponse): CodeReviewGroup[] {
  const groupTypeStrToReviews: {
    [groupTypeStr: string]: CodeReview[];
  } = {};

  for (const codeReview of res.codeReviews) {
    let groupType: CodeReviewGroupType;

    if (
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_MERGED ||
      codeReview.status ==
        CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE ||
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED
    ) {
      groupType = CodeReviewGroupType.MergedOrUpdated;
    } else if (
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW
    ) {
      groupType = CodeReviewGroupType.MustReviewOrCameBackFromSnooze;
    } else if (
      codeReview.status ==
        CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED ||
      codeReview.status ==
        CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME ||
      codeReview.status ==
        CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE
    ) {
      groupType = CodeReviewGroupType.Snoozed;
    } else if (
      codeReview.status ==
      CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE
    ) {
      groupType = CodeReviewGroupType.Reviewed;
    } else {
      groupType = CodeReviewGroupType.Rest;
    }

    if (groupTypeStrToReviews[groupType] === undefined) {
      groupTypeStrToReviews[groupType] = [];
    }
    groupTypeStrToReviews[groupType].push(codeReview);
  }

  // Sort code reviews within each group
  for (const codeReviews of Object.values(groupTypeStrToReviews)) {
    codeReviews.sort((a, b) => {
      return (
        // Reviews with latest changes are displayed on top, ordered by status
        (statusSortOrder[a.status] || 999) -
          (statusSortOrder[b.status] || 999) ||
        b.githubFields.updatedAtTimestamp - a.githubFields.updatedAtTimestamp
      );
    });
  }

  const codeReviewGroups: CodeReviewGroup[] = [];
  for (const groupType of codeReviewGroupTypes) {
    if (groupTypeStrToReviews[groupType] === undefined) {
      // No reviews in this group
      continue;
    }

    codeReviewGroups.push({
      groupType,
      groupTypeStrWithoutOrderPrefix: groupType.substring(
        groupType.indexOf('-') + 1,
      ),
      sortedCodeReviews: groupTypeStrToReviews[groupType],
    });
  }

  return codeReviewGroups;
}

export default class CodeReviewList extends Component<{}, CodeReviewListState> {
  lastAutoRefreshTimestamp: number;
  lastAutoRefreshErrorTimestamp: number;
  refreshIntervalCancel?: NodeJS.Timeout;

  constructor(props: {}) {
    super(props);

    this.lastAutoRefreshTimestamp = 0;
    this.lastAutoRefreshErrorTimestamp = 0;
    this.state = {
      codeReviewGroups: undefined,
      codeReviewIdsWithActiveCommands: new Set(),
    };
  }

  componentDidMount() {
    this.refresh(new GetCodeReviewsQuery());

    this.refreshIntervalCancel = setInterval(
      this.onIntervalBasedRefresh.bind(this),
      1000,
    );
  }

  componentWillUnmount() {
    if (this.refreshIntervalCancel !== undefined) {
      clearInterval(this.refreshIntervalCancel);
      this.refreshIntervalCancel = undefined;
    }
  }

  // Calculate how often and how many code reviews at once should be auto-refreshed. For a larger
  // number of code reviews with outdated information, the refresh should happen quickly. That happens
  // for example when opening workboard the first time in the morning of a working day.
  getAutoRefreshIntervalAndBatchSizeForAllCodeReviews(
    numCodeReviewsNeedingRefresh: number,
    nowTimestamp: number,
  ): {
    autoRefreshIntervalSeconds: number;
    numCodeReviewsToRefresh: number;
  } {
    const autoRefreshIntervalSeconds =
      // No clock drift?
      nowTimestamp - this.lastAutoRefreshErrorTimestamp >= -10 &&
      // Back off in case of errors (e.g. GitHub API rate limit)
      nowTimestamp - this.lastAutoRefreshErrorTimestamp < 60
        ? 15
        : numCodeReviewsNeedingRefresh > 50
          ? 2
          : 5;
    const numCodeReviewsToRefresh = Math.min(
      numCodeReviewsNeedingRefresh,
      Math.max(1, Math.min(5, Math.floor(numCodeReviewsNeedingRefresh / 10))),
    );

    return { autoRefreshIntervalSeconds, numCodeReviewsToRefresh };
  }

  // Calculate how often a code review should be refresh. Active PRs (= recently updated) should be updated more often.
  getAutoRefreshIntervalForSingleCodeReview(
    codeReview: CodeReview,
    nowTimestamp: number,
  ): number {
    const lastUpdatedAgeSeconds =
      nowTimestamp - codeReview.lastUpdatedTimestamp;

    const userDislikesReview =
      codeReview.status ==
      CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED;

    if (lastUpdatedAgeSeconds < -10) {
      // Large difference of clocks, treat like an old code review
      return 3600;
    } else if (lastUpdatedAgeSeconds < 300 && !userDislikesReview) {
      // Very, very recently active
      return 60;
    } else if (lastUpdatedAgeSeconds < 3600 && !userDislikesReview) {
      // Very recently active
      return 300;
    } else if (lastUpdatedAgeSeconds < 86400) {
      // Somewhat recently active
      return 900;
    } else if (lastUpdatedAgeSeconds < 14 * 86400) {
      return 7200;
    } else if (lastUpdatedAgeSeconds < 60 * 86400) {
      return 14400;
    } else {
      // Dying in a dusty corner
      return 86400;
    }
  }

  onIntervalBasedRefresh() {
    if (document.hidden || !(this.state.codeReviewsGrpcResult?.ok || false)) {
      return;
    }

    const nowTimestamp = Date.now() / 1000;

    const codeReviewsNeedingRefresh =
      this.state.codeReviewGroups
        ?.map((codeReviewGroup) =>
          codeReviewGroup.sortedCodeReviews.filter((codeReview) => {
            return (
              codeReview.status !=
                CodeReviewStatus.CODE_REVIEW_STATUS_DELETED &&
              nowTimestamp - codeReview.lastRefreshedTimestamp >=
                this.getAutoRefreshIntervalForSingleCodeReview(
                  codeReview,
                  nowTimestamp,
                )
            );
          }),
        )
        .flat(1) ?? [];

    if (codeReviewsNeedingRefresh.length === 0) {
      console.debug('No code reviews need a refresh');
      return;
    }

    const settings = this.getAutoRefreshIntervalAndBatchSizeForAllCodeReviews(
      codeReviewsNeedingRefresh.length,
      nowTimestamp,
    );

    if (
      // No clock drift
      nowTimestamp > this.lastAutoRefreshTimestamp &&
      // Not time yet to auto-refresh
      nowTimestamp - this.lastAutoRefreshTimestamp <
        settings.autoRefreshIntervalSeconds
    ) {
      return;
    }
    this.lastAutoRefreshTimestamp = nowTimestamp;
    console.info(
      `Auto-refresh with autoRefreshIntervalSeconds=${settings.autoRefreshIntervalSeconds} numCodeReviewsToRefresh=${settings.numCodeReviewsToRefresh} codeReviewsNeedingRefresh.length=${codeReviewsNeedingRefresh.length}`,
    );

    const hadCodeReviewIds = new Set<string>();

    for (let i = 0; i < settings.numCodeReviewsToRefresh; ++i) {
      let codeReviewToRefresh: CodeReview | undefined;
      for (let j = 0; j < 10; ++j) {
        // Give higher chances to top displayed code reviews
        codeReviewToRefresh = codeReviewsNeedingRefresh.at(
          codeReviewsNeedingRefresh.length * Math.pow(Math.random(), 1.2),
        );
        if (codeReviewToRefresh === undefined) {
          break;
        }

        if (hadCodeReviewIds.has(codeReviewToRefresh.id)) {
          continue;
        }
      }
      if (codeReviewToRefresh === undefined) {
        continue;
      }

      hadCodeReviewIds.add(codeReviewToRefresh.id);
      console.debug(
        `Refreshing code review (${i + 1}/${settings.numCodeReviewsToRefresh}) ` +
          `${codeReviewToRefresh.id} ` +
          `(${codeReviewToRefresh.githubFields?.url || '<URL unknown>'})`,
      );

      this.runCommandOnSingleCodeReview(
        codeReviewToRefresh.id,
        'refresh',
        (client, onResult) => {
          client.RefreshReview(
            new RefreshReviewCommand({
              codeReviewId: codeReviewToRefresh.id,
            }),
            null,
            (error, res) => {
              const commandResult = toGrpcResult(error, res);
              if (!commandResult.ok) {
                this.lastAutoRefreshErrorTimestamp = Date.now() / 1000;
              }

              onResult(error, res);
            },
          );
        },
      );
    }
  }

  runCommandOnSingleCodeReview(
    codeReviewId: string,
    commandDesc: string,
    runCommand: (
      client: WorkboardClient,
      onResult: (error: RpcError, res: CommandResponse) => void,
    ) => void,
  ) {
    const thiz = this;
    this.setState(
      {
        codeReviewIdsWithActiveCommands: new Set([
          ...this.state.codeReviewIdsWithActiveCommands,
          codeReviewId,
        ]),
      },
      () => {
        let client = new WorkboardClient('https://localhost:16667');
        runCommand(client, (error, res) => {
          const commandResult = toGrpcResult(error, res);
          if (!commandResult.ok) {
            console.error(
              `Command failed (${commandDesc}): ${commandResult.error}`,
            );

            // Continue to refresh since that will remove the code review from `codeReviewIdsWithActiveCommands`
            // and after an error, it's probably a good idea to get the latest data.
          }

          thiz.refetchCodeReview(codeReviewId);
        });
      },
    );
  }

  onDeleteReview(event: Event, codeReviewId: string) {
    event.preventDefault();

    if (!confirm('Really forget about this code review?')) {
      return;
    }

    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'delete review',
      (client, onResult) => {
        client.DeleteReview(
          new DeleteReviewCommand({ codeReviewId }),
          null,
          onResult,
        );
      },
    );
  }

  onMarkMustReview(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'mark as must-review',
      (client, onResult) => {
        client.MarkMustReview(
          new MarkMustReviewCommand({ codeReviewId }),
          null,
          onResult,
        );
      },
    );
  }

  onRefresh(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'refresh',
      (client, onResult) => {
        client.RefreshReview(
          new RefreshReviewCommand({ codeReviewId }),
          null,
          onResult,
        );
      },
    );
  }

  onRefreshAll(event: Event) {
    event.preventDefault();

    this.refresh(
      new GetCodeReviewsQuery({
        forceRefresh: true,
      }),
    );
  }

  onReviewedDeleteOnMerge(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'mark as reviewed, delete on merge',
      (client, onResult) => {
        client.ReviewedDeleteOnMerge(
          new ReviewedDeleteOnMergeCommand({ codeReviewId }),
          null,
          onResult,
        );
      },
    );
  }

  onSnoozeUntilMentioned(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'snooze until mentioned',
      (client, onResult) => {
        client.SnoozeUntilMentioned(
          new SnoozeUntilMentionedCommand({ codeReviewId }),
          null,
          onResult,
        );
      },
    );
  }

  onSnoozeUntilTime(event: Event, codeReviewId: string) {
    event.preventDefault();

    const select = event.currentTarget as HTMLSelectElement;
    let secondsFromNow = 0;
    for (const option of select.selectedOptions) {
      secondsFromNow = parseInt(option.value, 10);
      break;
    }
    if (secondsFromNow <= 0) {
      throw new Error('Failed to get snooze time from select element');
    }
    select.selectedIndex = 0;

    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'snooze until time',
      (client, onResult) => {
        client.SnoozeUntilTime(
          new SnoozeUntilTimeCommand({
            codeReviewId,
            snoozeUntilTimestamp: Math.floor(
              Date.now() / 1000 + secondsFromNow,
            ),
          }),
          null,
          onResult,
        );
      },
    );
  }

  onSnoozeUntilUpdate(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'snooze until update',
      (client, onResult) => {
        client.SnoozeUntilUpdate(
          new SnoozeUntilUpdateCommand({ codeReviewId }),
          null,
          onResult,
        );
      },
    );
  }

  // TODO: Only re-fetch single code review, not all. Delete from state if the code review is gone from database.
  refetchCodeReview(codeReviewId: string) {
    let client = new WorkboardClient('https://localhost:16667');

    const thiz = this;
    client.GetCodeReviews(new GetCodeReviewsQuery(), null, (error, res) => {
      const newCodeReviewIdsWithActiveCommands = new Set(
        this.state.codeReviewIdsWithActiveCommands,
      );
      newCodeReviewIdsWithActiveCommands.delete(codeReviewId);

      let codeReviewGroups: CodeReviewGroup[] | undefined =
        thiz.state.codeReviewGroups;
      if (res !== null) {
        codeReviewGroups = sortCodeReviews(res);
      }

      thiz.setState({
        codeReviewGroups,
        codeReviewsGrpcResult: toGrpcResult(error, res),
        codeReviewIdsWithActiveCommands: newCodeReviewIdsWithActiveCommands,
      });
    });
  }

  refresh(query: GetCodeReviewsQuery) {
    const thiz = this;
    this.setState({ codeReviewsGrpcResult: makePendingGrpcResult() }, () => {
      let client = new WorkboardClient('https://localhost:16667');

      client.GetCodeReviews(query, null, (error, res) => {
        let codeReviewGroups: CodeReviewGroup[] | undefined =
          thiz.state.codeReviewGroups;
        if (res !== null) {
          codeReviewGroups = sortCodeReviews(res);
        }

        this.setState({
          codeReviewGroups,
          codeReviewsGrpcResult: toGrpcResult(error, res),
        });
      });
    });
  }

  render() {
    const nowTimestamp = Date.now() / 1000;

    return (
      <>
        <table className="pull-requests">
          <thead>
            <tr>
              <th className="pull-requests-repo">Repo</th>
              <th className="pull-requests-status">Your status</th>
              <th className="pull-requests-github-status">GitHub state</th>
              <th className="pull-requests-actions">
                Actions
                <div className="global-code-reviews-actions">
                  <button onClick={(event) => this.onRefreshAll(event)}>
                    Refresh all
                  </button>
                  {this.state.codeReviewIdsWithActiveCommands.size > 0 && (
                    <Spinner />
                  )}
                </div>
              </th>
              <th className="pull-requests-last-updated">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {this.state.codeReviewsGrpcResult?.pending && <Spinner />}
            {this.state.codeReviewsGrpcResult?.error && (
              <tr>
                <td colSpan={5}>
                  <ErrorBanner
                    error={`Failed to list code reviews: ${this.state.codeReviewsGrpcResult.error.message}`}
                  />
                </td>
              </tr>
            )}

            {this.state.codeReviewsGrpcResult?.ok &&
              this.state.codeReviewGroups!.map((codeReviewGroup) => (
                <>
                  <tr
                    className={`code-review-group code-review-group-type-${codeReviewGroup.groupTypeStrWithoutOrderPrefix}`}
                  >
                    <td colSpan={5}>
                      {
                        codeReviewGroupTypeHeaderDescription[
                          codeReviewGroup.groupType
                        ]
                      }
                      <span
                        title={`${codeReviewGroup.sortedCodeReviews.length} review${
                          codeReviewGroup.sortedCodeReviews.length == 1
                            ? ''
                            : 's'
                        }`}
                      >
                        {' '}
                        ({codeReviewGroup.sortedCodeReviews.length})
                      </span>
                    </td>
                  </tr>
                  {codeReviewGroup.sortedCodeReviews.map(
                    (codeReview) =>
                      codeReview.status !=
                        CodeReviewStatus.CODE_REVIEW_STATUS_DELETED && (
                        <tr
                          className={`status-${codeReviewStatusToString(codeReview.status)}${nowTimestamp - codeReview.lastChangedTimestamp <= 3600 ? (nowTimestamp - codeReview.lastChangedTimestamp <= 900 ? ' very-recently-clicked' : ' recently-clicked') : ''}`}
                        >
                          <td>
                            <span className="repo-name">
                              {codeReview.githubFields
                                ? `${codeReview.githubFields.repo.organizationName}/${codeReview.githubFields.repo.name}`
                                : null}
                            </span>
                          </td>
                          <td
                            className={`status status-${codeReviewStatusToString(codeReview.status)}`}
                          >
                            {codeReview.status ==
                              CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME && (
                              <>
                                Snoozed until:{' '}
                                {timeago.format(
                                  new Date(
                                    codeReview.snoozeUntilTimestamp * 1000,
                                  ),
                                  'en',
                                )}
                              </>
                            )}

                            {codeReview.status ==
                              CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE && (
                              <>
                                Snoozed until update (last update was{' '}
                                {timeago.format(
                                  new Date(
                                    codeReview.snoozeUntilUpdatedAtChangedFrom *
                                      1000,
                                  ),
                                  'en',
                                )}
                                )
                              </>
                            )}

                            {codeReview.status !=
                              CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME &&
                              codeReview.status !=
                                CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE &&
                              codeReviewStatusToString(codeReview.status)}
                          </td>
                          <td className="github-status">
                            {codeReview.githubFields
                              ? gitHubPullRequestStatusToString(
                                  codeReview.githubFields.status,
                                )
                              : ''}
                          </td>
                          <td
                            style={`background-color: rgba${safeColor.random(codeReview.id).substring(3).replace(')', ', 0.1)')}`}
                          >
                            {codeReview.renderOnlyFields.avatarUrl.length >
                              0 && (
                              <img
                                className="code-review-avatar"
                                src={codeReview.renderOnlyFields.avatarUrl}
                              />
                            )}

                            <a
                              href={codeReview.githubFields?.url || ''}
                              className="pr-link"
                              target="_blank"
                              rel="noopener"
                              style={`color: ${safeColor.random(codeReview.id)}`}
                            >
                              {codeReview.githubFields?.title || ''}
                            </a>

                            <div
                              className={`actions ${this.state.codeReviewIdsWithActiveCommands.size > 1 || this.state.codeReviewIdsWithActiveCommands.has(codeReview.id) ? 'actions-disabled' : ''}`}
                            >
                              {codeReview.status !=
                                CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME &&
                                codeReview.status !=
                                  CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE && (
                                  <>
                                    <select
                                      onChange={(event) =>
                                        this.onSnoozeUntilTime(
                                          event,
                                          codeReview.id,
                                        )
                                      }
                                    >
                                      <option value="">Snooze for…</option>
                                      <option value="3600">1 hour</option>
                                      <option value="86400">1 day</option>
                                      <option value="604800">7 days</option>
                                      <option value="1209600">14 days</option>
                                    </select>
                                    <button
                                      onClick={(event) =>
                                        this.onSnoozeUntilUpdate(
                                          event,
                                          codeReview.id,
                                        )
                                      }
                                    >
                                      Snooze until update
                                    </button>
                                  </>
                                )}

                              {codeReview.status !=
                                CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW && (
                                <button
                                  onClick={(event) =>
                                    this.onMarkMustReview(event, codeReview.id)
                                  }
                                >
                                  Mark 'must review'
                                </button>
                              )}

                              {codeReview.githubFields?.status !=
                                GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED &&
                                codeReview.githubFields?.status !=
                                  GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED &&
                                codeReview.status !=
                                  CodeReviewStatus.CODE_REVIEW_STATUS_MERGED &&
                                codeReview.status !=
                                  CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED &&
                                codeReview.status !=
                                  CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE && (
                                  <button
                                    className="action-reviewed-delete-on-merge"
                                    onClick={(event) =>
                                      this.onReviewedDeleteOnMerge(
                                        event,
                                        codeReview.id,
                                      )
                                    }
                                  >
                                    I reviewed or merged; delete once merged
                                  </button>
                                )}

                              {(codeReview.status ==
                                CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED ||
                                codeReview.status ==
                                  CodeReviewStatus.CODE_REVIEW_STATUS_MERGED) && (
                                <button
                                  className="action-delete"
                                  onClick={(event) =>
                                    this.onDeleteReview(event, codeReview.id)
                                  }
                                >
                                  Delete
                                </button>
                              )}

                              {!codeReview.renderOnlyFields.authorIsSelf && (
                                <button
                                  onClick={(event) =>
                                    this.onSnoozeUntilMentioned(
                                      event,
                                      codeReview.id,
                                    )
                                  }
                                >
                                  Snooze until I'm mentioned
                                  <br />
                                  <small>(= someone else reviews)</small>
                                </button>
                              )}

                              <button
                                onClick={(event) =>
                                  this.onRefresh(event, codeReview.id)
                                }
                              >
                                Refresh
                              </button>

                              {this.state.codeReviewIdsWithActiveCommands.has(
                                codeReview.id,
                              ) && <Spinner />}
                            </div>
                          </td>
                          <td>
                            {codeReview.lastUpdatedTimestamp > 0
                              ? timeago.format(
                                  new Date(
                                    codeReview.lastUpdatedTimestamp * 1000,
                                  ),
                                  'en',
                                )
                              : null}
                          </td>
                        </tr>
                      ),
                  )}
                </>
              ))}
          </tbody>
        </table>
      </>
    );
  }
}
