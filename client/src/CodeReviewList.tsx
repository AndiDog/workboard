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
} from './generated/workboard';
import { GrpcResult, makePendingGrpcResult, toGrpcResult } from './grpc';
import Spinner from './Spinner';
import { RpcError } from 'grpc-web';

type CodeReviewListState = {
  codeReviewsGrpcResult?: GrpcResult<GetCodeReviewsResponse>;

  codeReviewIdsWithActiveCommands: Set<string>;
};

function codeReviewStatusToString(status: CodeReviewStatus): string {
  switch (status) {
    case CodeReviewStatus.CODE_REVIEW_STATUS_NEW:
      return 'new';
    case CodeReviewStatus.CODE_REVIEW_STATUS_MERGED:
      return 'merged';
    case CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME:
      return 'snoozed-until-time';
    case CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE:
      return 'snoozed-until-update';
    case CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE:
      return 'reviewed-delete-on-merge';
    case CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED:
      return 'closed';
  }
  throw new Error(`Unhandled value for CodeReviewStatus: ${status}`);
}

function gitHubPullRequestStatusToString(
  status: GitHubPullRequestStatus,
): string {
  switch (status) {
    case GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_OPEN:
      return 'open';
  }
  throw new Error(`Unhandled value for GitHubPullRequestStatus: ${status}`);
}

function sortCodeReviews(res: GetCodeReviewsResponse) {
  const statusSortOrder: Record<number, number> = {
    [CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED]: 1,
    [CodeReviewStatus.CODE_REVIEW_STATUS_DELETED]: 999, // not applicable since we filter those out for rendering
    [CodeReviewStatus.CODE_REVIEW_STATUS_MERGED]: 1,
    [CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW]: 2,
    [CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE]: 5,
    [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED]: 5,
    [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME]: 5,
    [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE]: 5,
    [CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE]: 1,
    [CodeReviewStatus.CODE_REVIEW_STATUS_UNSPECIFIED]: 4,
  };

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

  render = () => (
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
                  className={`status-${codeReviewStatusToString(codeReview.status)}${codeReview.renderOnlyFields.recentlyTouchedByUser ? ' last-clicked' : ''}`}
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
                        <button>Mark 'must review'</button>
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
                              this.onReviewedDeleteOnMerge(event, codeReview.id)
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
                        <button>
                          Snooze until I'm mentioned (= someone else reviews)
                        </button>
                      )}

                      {this.state.codeReviewIdsWithActiveCommands.has(
                        codeReview.id,
                      ) && <Spinner />}
                    </div>
                  </td>
                  <td>{codeReview.renderOnlyFields.lastUpdatedDescription}</td>
                </tr>
              ),
            )}
        </tbody>
      </table>
    </>
  );
}
