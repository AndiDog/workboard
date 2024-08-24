import { Component } from 'preact';
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
} from './generated/workboard';
import { GrpcResult, makePendingGrpcResult, toGrpcResult } from './grpc';
import Spinner from './Spinner';
import { RpcError } from 'grpc-web';
import { staticAssertOnce } from './util';

type CodeReviewListState = {
  codeReviewsGrpcResult?: GrpcResult<GetCodeReviewsResponse>;

  codeReviewIdsWithActiveCommands: Set<string>;
};

interface EnumToNumberObject {
  [index: number]: number;
}
interface EnumToStringObject {
  [index: number]: string;
}

const codeReviewStatusToStringMap: EnumToStringObject = {
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
  staticAssertOnce('2a6b2ef3-a45e-493f-b7d0-367db5d8e49b', () => {
    for (const x of Object.values(CodeReviewStatus)) {
      if (typeof x !== 'number') {
        continue;
      }
      if (codeReviewStatusToStringMap[x as number] === undefined) {
        throw new Error(
          `\`codeReviewStatusToStringMap\` does not contain all enum variants of \`CodeReviewStatus\`: ${x} is missing`,
        );
      }
    }
  });

  const value = codeReviewStatusToStringMap[status];
  if (value === undefined) {
    return '<codeReviewStatusToString logic error: unhandled enum value>';
  }
  return value;
}

const gitHubPullRequestStatusToStringMap: EnumToStringObject = {
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED]: 'closed',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED]: 'merged',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_OPEN]: 'open',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_UNSPECIFIED]:
    '<gitHubPullRequestStatusToStringMap logic error: unspecified enum value>',
};

function gitHubPullRequestStatusToString(
  status: GitHubPullRequestStatus,
): string {
  staticAssertOnce('e29de9cb-6dd7-4a8d-a756-fc60e153f6eb', () => {
    for (const x of Object.values(GitHubPullRequestStatus)) {
      if (typeof x !== 'number') {
        continue;
      }
      if (gitHubPullRequestStatusToStringMap[x as number] === undefined) {
        throw new Error(
          `\`gitHubPullRequestStatusToStringMap\` does not contain all enum variants of \`GitHubPullRequestStatus\`: ${x} is missing`,
        );
      }
    }
  });

  const value = gitHubPullRequestStatusToStringMap[status];
  if (value === undefined) {
    return '<gitHubPullRequestStatusToString logic error: unhandled enum value>';
  }
  return value;
}

const statusSortOrder: EnumToNumberObject = {
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

function sortCodeReviews(res: GetCodeReviewsResponse) {
  staticAssertOnce('19368936-25f5-4a3a-ba7a-4f5e54d09e40', () => {
    for (const x of Object.values(CodeReviewStatus)) {
      if (typeof x !== 'number') {
        continue;
      }
      if (statusSortOrder[x as number] === undefined) {
        throw new Error(
          `\`statusSortOrder\` does not contain all enum variants of \`CodeReviewStatus\`: ${x} is missing`,
        );
      }
    }
  });

  res.codeReviews.sort((a, b) => {
    return (
      // Reviews with latest changes are displayed on top, ordered by status
      (statusSortOrder[a.status] || 999) - (statusSortOrder[b.status] || 999) ||
      b.githubFields.updatedAtTimestamp - a.githubFields.updatedAtTimestamp
    );
  });
}

export default class CodeReviewList extends Component<{}, CodeReviewListState> {
  constructor(props: {}) {
    super(props);

    this.state = {
      codeReviewIdsWithActiveCommands: new Set(),
    };
  }

  componentDidMount() {
    this.setState({ codeReviewsGrpcResult: makePendingGrpcResult() }, () => {
      let client = new WorkboardClient('https://localhost:16667');

      const thiz = this;
      client.GetCodeReviews(new GetCodeReviewsQuery(), null, (error, res) => {
        if (res !== null) {
          sortCodeReviews(res);
        }
        thiz.setState({
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
      if (res !== null) {
        sortCodeReviews(res);
      }

      const newCodeReviewIdsWithActiveCommands = new Set(
        this.state.codeReviewIdsWithActiveCommands,
      );
      newCodeReviewIdsWithActiveCommands.delete(codeReviewId);
      thiz.setState({
        codeReviewsGrpcResult: toGrpcResult(error, res),
        codeReviewIdsWithActiveCommands: newCodeReviewIdsWithActiveCommands,
      });
    });
  }

  uncache(_codeReviewId: string) {
    // TODO
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
              this.state.codeReviewsGrpcResult.res.codeReviews.map(
                (codeReview) => (
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
                      className={`status-${codeReviewStatusToString(codeReview.status)}`}
                    >
                      {codeReviewStatusToString(codeReview.status)}
                    </td>
                    <td>
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
                        onClick={() => this.uncache(codeReview.id)}
                      >
                        {codeReview.githubFields?.title || ''}
                      </a>

                      <div className="actions">
                        {codeReview.status !=
                          CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME &&
                          codeReview.status !=
                            CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE && (
                            <>
                              <button>Snooze for 1 day</button>
                              <button
                                onClick={(event) =>
                                  this.onSnoozeUntilUpdate(event, codeReview.id)
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
                              this.onSnoozeUntilMentioned(event, codeReview.id)
                            }
                          >
                            Snooze until I'm mentioned
                            <br />
                            <small>(= someone else reviews)</small>
                          </button>
                        )}

                        {this.state.codeReviewIdsWithActiveCommands.has(
                          codeReview.id,
                        ) && <Spinner />}
                      </div>
                    </td>
                    <td>
                      {codeReview.renderOnlyFields.lastUpdatedDescription}
                    </td>
                  </tr>
                ),
              )}
          </tbody>
        </table>
      </>
    );
  }
}
