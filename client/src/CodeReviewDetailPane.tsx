import { Component } from 'preact';
import * as timeago from 'timeago.js';
import {
  CodeReview,
  CodeReviewStatus,
  GitHubPullRequestStatus,
} from './generated/workboard';
import {
  canMarkReviewedDeleteOnMerge,
  canSnoozeUntilTimeOrUpdate,
  CodeReviewAvatar,
  codeReviewSignals,
  codeReviewStatusTone,
  SignalBadge,
  snoozeDurations,
} from './codeReviewDisplay';
import Spinner from './Spinner';

type CodeReviewDetailPaneProps = {
  codeReview: CodeReview;
  gitHubStatus: string;
  hasActiveCommand: boolean;
  isDeletable: boolean;
  onClose: () => void;
  onDelete: (event: Event) => void;
  onMarkMustReview: (event: Event) => void;
  onRefresh: (event: Event) => void;
  onReviewedDeleteOnMerge: (event: Event) => void;
  onSetManualWeight: (event: Event) => void;
  onSnoozeUntilMentioned: (event: Event) => void;
  onSnoozeUntilTime: (event: Event, secondsFromNow: number) => void;
  onSnoozeUntilUpdate: (event: Event) => void;
  onVisit: () => void;
  statusDescription: string;
};

function RelativeTime(props: { timestamp: number }) {
  const date = new Date(props.timestamp * 1000);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {timeago.format(date, 'en')}
    </time>
  );
}

export default class CodeReviewDetailPane extends Component<CodeReviewDetailPaneProps> {
  render() {
    const codeReview = this.props.codeReview;
    const signals = codeReviewSignals(codeReview);
    const url = codeReview.githubFields?.url || '';
    const authorName =
      codeReview.renderOnlyFields.authorName ||
      codeReview.githubFields?.authorLogin ||
      '';
    const authorLogin = codeReview.githubFields?.authorLogin ?? '';
    const approvedByLogins = codeReview.githubFields?.approvedByLogins ?? [];
    const canSnooze = canSnoozeUntilTimeOrUpdate(codeReview);
    const disabled = this.props.hasActiveCommand;
    const actionsClassName = `actions ${disabled ? 'actions-disabled' : ''}`;

    const gitHubStatus = codeReview.githubFields?.status;
    const gitHubStatusTone =
      gitHubStatus == GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED
        ? 'success'
        : gitHubStatus ==
            GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED
          ? 'danger'
          : undefined;

    return (
      <aside
        className="code-review-detail-pane"
        aria-label="Code review details"
      >
        <div className="detail-pane-header">
          <span className="repo-name detail-pane-repo">
            {codeReview.githubFields
              ? `${codeReview.githubFields.repo.organizationName}/${codeReview.githubFields.repo.name} #${codeReview.githubFields.number}`
              : null}
          </span>
          {this.props.hasActiveCommand && <Spinner />}
          <a
            href={url}
            className="detail-pane-icon-button"
            target="_blank"
            rel="noopener"
            title="Open on GitHub"
            aria-label="Open on GitHub"
            onClick={() => this.props.onVisit()}
          >
            <i className="bi bi-box-arrow-up-right" />
          </a>
          <button
            type="button"
            className="detail-pane-icon-button"
            title="Close (Esc)"
            aria-label="Close details"
            onClick={() => this.props.onClose()}
          >
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <h2 className="detail-pane-title">
          <a
            href={url}
            target="_blank"
            rel="noopener"
            onClick={() => this.props.onVisit()}
          >
            {codeReview.githubFields?.title || ''}
          </a>
        </h2>

        <div className="detail-pane-badges">
          <span
            className={`badge badge-${codeReviewStatusTone(codeReview.status)}`}
          >
            {this.props.statusDescription}
          </span>
          {gitHubStatusTone !== undefined && (
            <span className={`badge badge-${gitHubStatusTone}`}>
              {this.props.gitHubStatus} on GitHub
            </span>
          )}
          {signals.pipeline && <SignalBadge signal={signals.pipeline} />}
          {signals.approval && <SignalBadge signal={signals.approval} />}
          {signals.draft && <SignalBadge signal={signals.draft} />}
          {signals.autoMerge && <SignalBadge signal={signals.autoMerge} />}
        </div>

        <dl className="detail-pane-facts">
          <dt>Author</dt>
          <dd>
            <CodeReviewAvatar codeReview={codeReview} />
            {authorName}
            {authorLogin.length > 0 && authorLogin != authorName
              ? ` (${authorLogin})`
              : null}
          </dd>
          {approvedByLogins.length > 0 && (
            <>
              <dt>Approved by</dt>
              <dd>{approvedByLogins.join(', ')}</dd>
            </>
          )}
          {codeReview.lastUpdatedTimestamp > 0 && (
            <>
              <dt>Updated</dt>
              <dd>
                <RelativeTime timestamp={codeReview.lastUpdatedTimestamp} />
              </dd>
            </>
          )}
          {codeReview.lastMentionTimestamp > 0 && (
            <>
              <dt>Mentioned</dt>
              <dd>
                <RelativeTime timestamp={codeReview.lastMentionTimestamp} />
              </dd>
            </>
          )}
          {codeReview.lastVisitedTimestamp > 0 && (
            <>
              <dt>Last visited</dt>
              <dd>
                <RelativeTime timestamp={codeReview.lastVisitedTimestamp} />
              </dd>
            </>
          )}
          <dt>Weight</dt>
          <dd className={actionsClassName}>
            {codeReview.renderOnlyFields.weight}
            {codeReview.hasManualWeightOverride ? ' (manual override)' : null}
            <button
              type="button"
              onClick={this.props.onSetManualWeight}
              disabled={disabled}
            >
              Set weight…
            </button>
          </dd>
        </dl>

        {(canSnooze || !codeReview.renderOnlyFields.authorIsSelf) && (
          <section className="detail-pane-section">
            <h3>Snooze</h3>
            {canSnooze && (
              <div
                className={`button-group ${disabled ? 'actions-disabled' : ''}`}
                role="group"
                aria-label="Snooze for"
              >
                {snoozeDurations.map((snoozeDuration) => (
                  <button
                    key={snoozeDuration.seconds}
                    type="button"
                    onClick={(event) =>
                      this.props.onSnoozeUntilTime(
                        event,
                        snoozeDuration.seconds,
                      )
                    }
                    disabled={disabled}
                  >
                    {snoozeDuration.label}
                  </button>
                ))}
              </div>
            )}
            <div className={actionsClassName}>
              {canSnooze && (
                <button
                  type="button"
                  onClick={this.props.onSnoozeUntilUpdate}
                  disabled={disabled}
                >
                  Until the PR is updated
                </button>
              )}
              {!codeReview.renderOnlyFields.authorIsSelf && (
                <button
                  type="button"
                  onClick={this.props.onSnoozeUntilMentioned}
                  disabled={disabled}
                >
                  Until I'm mentioned <small>(= someone else reviews)</small>
                </button>
              )}
            </div>
          </section>
        )}

        <section className="detail-pane-section">
          <h3>Triage</h3>
          <div className={actionsClassName}>
            {canMarkReviewedDeleteOnMerge(codeReview) && (
              <button
                type="button"
                className="action-reviewed-delete-on-merge"
                onClick={this.props.onReviewedDeleteOnMerge}
                disabled={disabled}
              >
                I reviewed or merged; delete once merged
              </button>
            )}
            {codeReview.status !=
              CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW && (
              <button
                type="button"
                onClick={this.props.onMarkMustReview}
                disabled={disabled}
              >
                Mark 'must review'
              </button>
            )}
            {this.props.isDeletable && (
              <button
                type="button"
                className="action-delete"
                onClick={this.props.onDelete}
                disabled={disabled}
              >
                Delete
              </button>
            )}
          </div>
        </section>

        <section className="detail-pane-section">
          <h3>More</h3>
          <div className={actionsClassName}>
            <button
              type="button"
              onClick={this.props.onRefresh}
              disabled={disabled}
            >
              Refresh from GitHub
            </button>
          </div>
        </section>
      </aside>
    );
  }
}
