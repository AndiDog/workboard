import {
  CodeReview,
  CodeReviewStatus,
  GitHubPullRequestStatus,
} from './generated/workboard';

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

export const snoozeDurations: Array<{ label: string; seconds: number }> = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '3 days', seconds: 259200 },
  { label: '7 days', seconds: 604800 },
  { label: '14 days', seconds: 1209600 },
];

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

export function codeReviewStatusTone(status: CodeReviewStatus): Tone {
  return statusToTone[status] ?? 'danger';
}

export function SignalBadge(props: { signal: Signal }) {
  return (
    <span className={`badge badge-${props.signal.tone}`}>
      <i className={props.signal.iconClassName} />
      {props.signal.label}
    </span>
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
