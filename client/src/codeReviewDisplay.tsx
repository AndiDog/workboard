import * as timeago from 'timeago.js';
import {
  CodeReview,
  CodeReviewStatus,
  GitHubPullRequestStatus,
} from './generated/workboard';
import Spinner from './Spinner';

export type Tone =
  | 'danger'
  | 'info'
  | 'mention'
  | 'muted'
  | 'success'
  | 'warning';

export type Signal = {
  iconClassName: string;
  label: string;
  tone: Tone;
};

export type CodeReviewSignals = {
  approval?: Signal;
  autoMerge?: Signal;
  draft?: Signal;
  pipeline?: Signal;
};

const codeReviewStatusToStringMap: {
  [codeReviewStatus in CodeReviewStatus]: string;
} = {
  [CodeReviewStatus.CODE_REVIEW_STATUS_ARCHIVED]: 'archived',
  [CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED]: 'closed',
  [CodeReviewStatus.CODE_REVIEW_STATUS_DELETED]: 'deleted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_MENTIONED]: 'mentioned',
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

const gitHubPullRequestStatusToStringMap: {
  [gitHubPullRequestStatus in GitHubPullRequestStatus]: string;
} = {
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED]: 'closed',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED]: 'merged',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_OPEN]: 'open',
  [GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_UNSPECIFIED]:
    '<gitHubPullRequestStatusToStringMap logic error: unspecified enum value>',
};

const recentUpdateMaxAgeSeconds = 86400;

export const snoozeDurations: Array<{ label: string; seconds: number }> = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '3 days', seconds: 259200 },
  { label: '7 days', seconds: 604800 },
  { label: '14 days', seconds: 1209600 },
];

// The row's group or GitHub state already conveys these
const statusesWithoutDescriptionInRow = new Set([
  CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED,
  CodeReviewStatus.CODE_REVIEW_STATUS_MERGED,
  CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW,
  CodeReviewStatus.CODE_REVIEW_STATUS_NEW,
]);

const statusToTone: { [codeReviewStatus in CodeReviewStatus]: Tone } = {
  [CodeReviewStatus.CODE_REVIEW_STATUS_ARCHIVED]: 'muted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED]: 'danger',
  [CodeReviewStatus.CODE_REVIEW_STATUS_DELETED]: 'muted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_MENTIONED]: 'mention',
  [CodeReviewStatus.CODE_REVIEW_STATUS_MERGED]: 'success',
  [CodeReviewStatus.CODE_REVIEW_STATUS_MUST_REVIEW]: 'warning',
  [CodeReviewStatus.CODE_REVIEW_STATUS_NEW]: 'info',
  [CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE]: 'muted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED]: 'muted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME]: 'muted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE]: 'muted',
  [CodeReviewStatus.CODE_REVIEW_STATUS_UNSPECIFIED]: 'danger',
  [CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE]: 'success',
};

const veryRecentUpdateMaxAgeSeconds = 14400;

export function canMarkReviewedDeleteOnMerge(codeReview: CodeReview): boolean {
  return (
    codeReview.githubFields?.status !=
      GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED &&
    codeReview.githubFields?.status !=
      GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED &&
    codeReview.status != CodeReviewStatus.CODE_REVIEW_STATUS_MERGED &&
    codeReview.status != CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED &&
    codeReview.status != CodeReviewStatus.CODE_REVIEW_STATUS_ARCHIVED &&
    codeReview.status !=
      CodeReviewStatus.CODE_REVIEW_STATUS_REVIEWED_DELETE_ON_MERGE
  );
}

export function canSnoozeUntilTimeOrUpdate(codeReview: CodeReview): boolean {
  return (
    codeReview.status !=
      CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME &&
    codeReview.status !=
      CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE
  );
}

export function CodeReviewAvatar(props: { codeReview: CodeReview }) {
  const authorName =
    props.codeReview.renderOnlyFields.authorName ||
    props.codeReview.githubFields?.authorLogin ||
    '';

  if (props.codeReview.renderOnlyFields.avatarUrl.length > 0) {
    return (
      <img
        className="code-review-avatar"
        src={props.codeReview.renderOnlyFields.avatarUrl}
        title={authorName}
        alt=""
      />
    );
  }

  // The server drops auto-generated avatars (e.g. of bots)
  return (
    <span
      className="code-review-avatar code-review-avatar-placeholder"
      title={authorName}
    >
      <i className="bi bi-person" />
    </span>
  );
}

export function CodeReviewInfoCells(props: {
  codeReview: CodeReview;
  hasActiveCommand?: boolean;
  identityColor?: string;
  onTitleClick?: (event: MouseEvent) => void;
}) {
  const codeReview = props.codeReview;
  const signals = codeReviewSignals(codeReview);
  const authorName =
    codeReview.renderOnlyFields.authorName ||
    codeReview.githubFields?.authorLogin ||
    '';

  return (
    <>
      <td
        className="signal"
        style={
          props.identityColor === undefined
            ? undefined
            : `box-shadow: inset 0.25em 0 0 ${props.identityColor}`
        }
      >
        {signals.pipeline && <SignalIcon signal={signals.pipeline} />}
      </td>
      <td className="signal">
        {signals.approval && <SignalIcon signal={signals.approval} />}
      </td>
      <td className="signal">
        {signals.draft && <SignalIcon signal={signals.draft} />}
      </td>
      <td className="signal">
        {signals.autoMerge && <SignalIcon signal={signals.autoMerge} />}
      </td>
      <td className="avatar">
        {props.hasActiveCommand ? (
          // Keep the avatar's box size so the row doesn't shift
          <span className="code-review-avatar code-review-avatar-placeholder">
            <Spinner />
          </span>
        ) : (
          <CodeReviewAvatar codeReview={codeReview} />
        )}
      </td>
      <td className="code-review-summary">
        <div className="code-review-title">
          <a
            href={codeReview.githubFields?.url || ''}
            className="pr-link"
            target="_blank"
            rel="noopener"
            title={codeReview.githubFields?.title || ''}
            onClick={props.onTitleClick}
          >
            {codeReview.githubFields?.title || ''}
          </a>
        </div>
        <div className="code-review-meta">
          {codeReview.githubFields && (
            <>
              <span className="repo-name">
                {`${codeReview.githubFields.repo.organizationName}/${codeReview.githubFields.repo.name}`}
              </span>{' '}
              #{codeReview.githubFields.number}
            </>
          )}
          {authorName.length > 0 && ` · ${authorName}`}
          {codeReview.lastUpdatedTimestamp > 0 && (
            <>
              {' · '}
              <span
                className={recentUpdateBadgeClassName(
                  codeReview.lastUpdatedTimestamp,
                )}
              >
                {`updated ${timeago.format(
                  new Date(codeReview.lastUpdatedTimestamp * 1000),
                  'en',
                )}`}
              </span>
            </>
          )}
          {!statusesWithoutDescriptionInRow.has(codeReview.status) &&
            ` · ${codeReviewStatusDescription(codeReview)}`}
          {(codeReview.githubFields?.status ==
            GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED ||
            codeReview.githubFields?.status ==
              GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED) &&
            ` · ${gitHubPullRequestStatusToString(codeReview.githubFields.status)} on GitHub`}
        </div>
      </td>
    </>
  );
}

// `<col>` elements matching `CodeReviewInfoCells`
export function CodeReviewInfoColumns() {
  return (
    <>
      <col className="pull-requests-signal" />
      <col className="pull-requests-signal" />
      <col className="pull-requests-signal" />
      <col className="pull-requests-signal" />
      <col className="pull-requests-avatar" />
      <col />
    </>
  );
}

export function codeReviewSignals(codeReview: CodeReview): CodeReviewSignals {
  const ret: CodeReviewSignals = {};

  const pipelineStatus = codeReview.githubFields?.statusCheckRollupStatus;
  if (pipelineStatus == 'SUCCESS') {
    ret.pipeline = {
      iconClassName: 'icon icon-check-double',
      label: 'Pipeline succeeded',
      tone: 'success',
    };
  } else if (pipelineStatus == 'PENDING') {
    ret.pipeline = {
      iconClassName: 'icon icon-hourglass',
      label: 'Pipeline pending or on hold',
      tone: 'warning',
    };
  } else if (pipelineStatus == 'FAILURE') {
    ret.pipeline = {
      iconClassName: 'icon icon-xmark',
      label: 'Pipeline failed',
      tone: 'danger',
    };
  }

  if (codeReview.renderOnlyFields.approvedBySelf) {
    ret.approval = {
      iconClassName: 'bi bi-hand-thumbs-up-fill',
      label: 'Approved by you',
      tone: 'success',
    };
  } else if (codeReview.renderOnlyFields.approvedByOthers) {
    ret.approval = {
      iconClassName: 'bi bi-hand-thumbs-up',
      label: 'Approved by others',
      tone: 'muted',
    };
  }

  if (codeReview.githubFields?.isDraft) {
    ret.draft = {
      iconClassName: 'icon icon-memo-pencil',
      label: 'Draft',
      tone: 'muted',
    };
  }

  if (codeReview.githubFields?.willAutoMerge) {
    ret.autoMerge = {
      iconClassName: 'icon icon-code-merge',
      label: 'Auto-merge enabled',
      tone: 'info',
    };
  }

  return ret;
}

export function codeReviewStatusDescription(codeReview: CodeReview): string {
  switch (codeReview.status) {
    case CodeReviewStatus.CODE_REVIEW_STATUS_MENTIONED:
      return `mentioned ${timeago.format(new Date(codeReview.lastMentionTimestamp * 1000), 'en')}`;
    case CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED:
      return 'snoozed until mentioned';
    case CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME:
      return `snoozed, back ${timeago.format(new Date(codeReview.snoozeUntilTimestamp * 1000), 'en')}`;
    case CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE:
      return `snoozed until update (last update was ${timeago.format(new Date(codeReview.snoozeUntilUpdatedAtChangedFrom * 1000), 'en')})`;
    default:
      return codeReviewStatusToString(codeReview.status).replace(/-/g, ' ');
  }
}

export function codeReviewStatusTone(status: CodeReviewStatus): Tone {
  return statusToTone[status] ?? 'danger';
}

export function codeReviewStatusToString(status: CodeReviewStatus): string {
  const value = codeReviewStatusToStringMap[status];
  if (value === undefined) {
    return '<codeReviewStatusToString logic error: unhandled enum value>';
  }
  return value;
}

export function gitHubPullRequestStatusToString(
  status: GitHubPullRequestStatus,
): string {
  const value = gitHubPullRequestStatusToStringMap[status];
  if (value === undefined) {
    return '<gitHubPullRequestStatusToString logic error: unhandled enum value>';
  }
  return value;
}

export function recentUpdateBadgeClassName(
  lastUpdatedTimestamp: number,
): string | undefined {
  // Negative in case of clock drift, which counts as very recent
  const ageSeconds = Date.now() / 1000 - lastUpdatedTimestamp;
  if (ageSeconds < veryRecentUpdateMaxAgeSeconds) {
    return 'recent-update-badge recent-update-badge-very-recent';
  }
  if (ageSeconds < recentUpdateMaxAgeSeconds) {
    return 'recent-update-badge recent-update-badge-recent';
  }
  return undefined;
}

export function SignalBadge(props: { signal: Signal }) {
  return (
    <span className={`badge badge-${props.signal.tone}`}>
      <i className={props.signal.iconClassName} />
      {props.signal.label}
    </span>
  );
}

export function SignalColumnHeaders() {
  return (
    <>
      <th className="signal" title="Pipeline status">
        <i className="icon icon-check-double" />
      </th>
      <th className="signal" title="Approval">
        <i className="bi bi-hand-thumbs-up" />
      </th>
      <th className="signal" title="Draft">
        <i className="icon icon-memo-pencil" />
      </th>
      <th className="signal" title="Auto-merge">
        <i className="icon icon-code-merge" />
      </th>
    </>
  );
}

export function SignalIcon(props: { signal: Signal }) {
  return (
    <i
      className={`${props.signal.iconClassName} tone-${props.signal.tone}`}
      title={props.signal.label}
      role="img"
      aria-label={props.signal.label}
    />
  );
}

export function simplePlural(count: number, singular: string) {
  if (count == 1) {
    return singular;
  }
  return singular + 's';
}
