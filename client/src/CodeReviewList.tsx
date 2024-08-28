import { Component } from 'preact';
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
} from './generated/workboard';
import { GrpcResult, makePendingGrpcResult, toGrpcResult } from './grpc';
import Spinner from './Spinner';
import { RpcError } from 'grpc-web';

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
        CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE
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
  constructor(props: {}) {
    super(props);

    this.state = {
      codeReviewGroups: undefined,
      codeReviewIdsWithActiveCommands: new Set(),
    };
  }

  componentDidMount() {
    this.setState({ codeReviewsGrpcResult: makePendingGrpcResult() }, () => {
      let client = new WorkboardClient('https://localhost:16667');

      const thiz = this;
      client.GetCodeReviews(new GetCodeReviewsQuery(), null, (error, res) => {
        let codeReviewGroups: CodeReviewGroup[] | undefined =
          thiz.state.codeReviewGroups;
        if (res !== null) {
          codeReviewGroups = sortCodeReviews(res);
        }

        thiz.setState({
          codeReviewGroups,
          codeReviewsGrpcResult: toGrpcResult(error, res),
        });
      });
    });
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

  onSnoozeUntilTime(
    event: Event,
    codeReviewId: string,
    secondsFromNow: number,
  ) {
    event.preventDefault();
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

  render() {
    const nowTimestamp = Date.now() / 1000;

    return (
      <>
        <table className="pull-requests">
          <thead>
            <tr>
              <th>Repo</th>
              <th>Your status</th>
              <th>GitHub state</th>
              <th>Actions</th>
              <th>Last updated</th>
            </tr>
          </thead>
          <tbody>
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
                  {codeReviewGroup.sortedCodeReviews.map((codeReview) => (
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
                              new Date(codeReview.snoozeUntilTimestamp * 1000),
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
                      <td>
                        <a
                          href={codeReview.githubFields?.url || ''}
                          className="pr-link"
                          target="_blank"
                          rel="noopener"
                        >
                          {codeReview.githubFields?.title || ''}
                        </a>

                        <div className="actions">
                          {codeReview.status !=
                            CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME &&
                            codeReview.status !=
                              CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE && (
                              <>
                                <button
                                  onClick={(event) =>
                                    // TODO Offer choice of how long to snooze
                                    this.onSnoozeUntilTime(
                                      event,
                                      codeReview.id,
                                      86400,
                                    )
                                  }
                                >
                                  Snooze for 1 day
                                </button>
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
                            <button className="action-delete">Delete</button>
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
                              new Date(codeReview.lastUpdatedTimestamp * 1000),
                              'en',
                            )
                          : null}
                      </td>
                    </tr>
                  ))}
                </>
              ))}
          </tbody>
        </table>
      </>
    );
  }
}
