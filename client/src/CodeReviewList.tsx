import { Component, Fragment } from 'preact';
import SafeColor from './vendor/safecolor/safecolor';
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
  MarkVisitedCommand,
  RelistReviewsCommand,
  RefreshReviewsCommand,
  SetCodeReviewManualWeightCommand,
} from './generated/workboard';
import {
  grpcBatchTimeoutMs,
  grpcCommandTimeoutMs,
  grpcDeadline,
  grpcQueryTimeoutMs,
  GrpcResult,
  isGrpcTimeout,
  makePendingGrpcResult,
  toGrpcResult,
} from './grpc';
import Spinner from './Spinner';
import { RpcError } from 'grpc-web';
import { grpcWebServerUrl } from './config';
import ErrorBanner from './ErrorBanner';
import CodeReviewDetailPane from './CodeReviewDetailPane';
import {
  canMarkReviewedDeleteOnMerge,
  canSnoozeUntilTimeOrUpdate,
  CodeReviewInfoCells,
  CodeReviewInfoColumns,
  codeReviewStatusDescription,
  codeReviewStatusToString,
  gitHubPullRequestStatusToString,
  SignalColumnHeaders,
  simplePlural,
  snoozeDurations,
} from './codeReviewDisplay';
import DeleteCodeReviewsDialog from './DeleteCodeReviewsDialog';

const safeColor = new SafeColor({ color: [255, 255, 255], contrast: 3 });

// Cache the color per id so re-renders don't recompute it
const safeColorCache = new Map<string, string>();
function safeColorForId(id: string): string {
  let color = safeColorCache.get(id);
  if (color === undefined) {
    color = safeColor.random(id);
    safeColorCache.set(id, color);
  }
  return color;
}

function alertCommandTimeout(commandDesc: string) {
  alert(
    `Command "${commandDesc}" timed out after ${grpcCommandTimeoutMs / 1000} seconds. ` +
      'It may still be running on the server, so the list will be refreshed.',
  );
}

type CodeReviewListState = {
  codeReviewGroups?: CodeReviewGroup[];
  codeReviewsGrpcResult?: GrpcResult<GetCodeReviewsResponse>;

  codeReviewIdsWithActiveCommands: Set<string>;

  // Snapshot shown in the delete dialog while it's open
  deleteDialogCodeReviews?: CodeReview[];

  relistCommandGrpcResult?: GrpcResult<CommandResponse>;

  searchEnabled: boolean;
  searchText: string;

  hiddenCodeReviewGroups: Set<CodeReviewGroupType>;

  selectedCodeReviewId?: string;

  // Don't forget to change `shouldComponentUpdate` when adding state fields!
};

const snoozeUntilMentionedOptionValue = 'mentioned';
const snoozeUntilUpdateOptionValue = 'update';

const statusSortOrder: {
  [codeReviewStatus in CodeReviewStatus]: number;
} = {
  // Low number = sorted to top, high number = sorted to bottom
  [CodeReviewStatus.CODE_REVIEW_STATUS_ARCHIVED]: 1,
  [CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED]: 1,
  [CodeReviewStatus.CODE_REVIEW_STATUS_DELETED]: 999, // not applicable since we filter those out for rendering
  [CodeReviewStatus.CODE_REVIEW_STATUS_MENTIONED]: 1,
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
  Mentioned = '050-mentioned',
  MergedOrUpdated = '100-merged-or-updated',
  MustReviewOrCameBackFromSnooze = '200-must-review',
  Rest = '700-rest',
  Reviewed = '800-reviewed',
  Snoozed = '900-snoozed',
  Ignored = '950-ignored',
}

const codeReviewGroupTypes: Array<CodeReviewGroupType> =
  Object.values(CodeReviewGroupType);

const codeReviewGroupTypeHeaderDescription: {
  [groupType in CodeReviewGroupType]: string;
} = {
  [CodeReviewGroupType.Mentioned]: 'You were mentioned',
  [CodeReviewGroupType.MergedOrUpdated]: 'Merged or updated',
  [CodeReviewGroupType.MustReviewOrCameBackFromSnooze]: 'Must review',
  [CodeReviewGroupType.Rest]: 'Other',
  [CodeReviewGroupType.Reviewed]: 'Reviewed',
  [CodeReviewGroupType.Snoozed]: 'Snoozed',
  [CodeReviewGroupType.Ignored]: 'Ignored',
};

// Final weight at or below which a code review is considered ignored
const ignoredWeightThreshold = -1000;

type CodeReviewGroup = {
  groupType: CodeReviewGroupType;
  groupTypeStrWithoutOrderPrefix: string; // e.g. `must-review` (trimmed from `000-must-review`; used for CSS classes)
  sortedCodeReviews: CodeReview[];
};

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    let chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

function sortCodeReviews(res: GetCodeReviewsResponse): CodeReviewGroup[] {
  const groupTypeStrToReviews: {
    [groupTypeStr: string]: CodeReview[];
  } = {};

  for (const codeReview of res.codeReviews) {
    let groupType: CodeReviewGroupType;

    if (codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_DELETED) {
      continue;
    }

    if (codeReview.renderOnlyFields.weight <= ignoredWeightThreshold) {
      groupType = CodeReviewGroupType.Ignored;
    } else if (
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_MENTIONED
    ) {
      groupType = CodeReviewGroupType.Mentioned;
    } else if (
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_MERGED ||
      codeReview.status ==
        CodeReviewStatus.CODE_REVIEW_STATUS_UPDATED_AFTER_SNOOZE ||
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED ||
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_ARCHIVED
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
        // Highest weight comes first
        b.renderOnlyFields.weight - a.renderOnlyFields.weight ||
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
  lastAutoRelistTimestamp: number;
  lastAutoRefreshTimestamp: number;
  lastAutoRefreshErrorTimestamp: number;
  localLastRefreshedTimestampMap: Map<string, number>;
  numRunningAutoRefreshRequests: number;
  refreshIntervalCancel?: NodeJS.Timeout;

  // Monotonic counter identifying the latest GetCodeReviews request. Responses
  // whose captured value is stale are ignored so a slow older response can't
  // overwrite a newer one.
  getCodeReviewsSeq: number;

  // Whether the component is mounted, used to skip setState from async gRPC
  // callbacks that resolve after unmount
  mounted: boolean;

  constructor(props: {}) {
    super(props);

    this.lastAutoRelistTimestamp = 0;
    this.lastAutoRefreshTimestamp = 0;
    this.lastAutoRefreshErrorTimestamp = 0;
    this.localLastRefreshedTimestampMap = new Map();
    this.numRunningAutoRefreshRequests = 0;
    this.getCodeReviewsSeq = 0;
    this.mounted = false;
    this.state = {
      codeReviewGroups: undefined,
      codeReviewIdsWithActiveCommands: new Set(),
      hiddenCodeReviewGroups: new Set([
        CodeReviewGroupType.Reviewed,
        CodeReviewGroupType.Snoozed,
        CodeReviewGroupType.Ignored,
      ]),
      searchEnabled: false,
      searchText: '',
    };
  }

  componentDidMount() {
    this.mounted = true;

    this.refresh();

    this.refreshIntervalCancel = setInterval(
      this.onIntervalBasedRefresh.bind(this),
      1000,
    );

    document.addEventListener('keydown', this.onDocumentKeyDown);
  }

  componentWillUnmount() {
    this.mounted = false;

    document.removeEventListener('keydown', this.onDocumentKeyDown);

    if (this.refreshIntervalCancel !== undefined) {
      clearInterval(this.refreshIntervalCancel);
      this.refreshIntervalCancel = undefined;
    }
  }

  shouldComponentUpdate(
    _nextProps: {},
    nextState: Readonly<CodeReviewListState>,
  ): boolean {
    // Do not hash `codeReviewsGrpcResult` because we generate a to-be-rendered, sorted list from it

    let beforeHash = 0;
    let afterHash = 0;

    if (
      // `relistCommandGrpcResult` is always replaced wholesale (never mutated
      // in place), so a reference comparison detects a relist result
      // (including an error to show) and any later change.
      this.state.relistCommandGrpcResult !==
        nextState.relistCommandGrpcResult ||
      this.state.codeReviewIdsWithActiveCommands.size !=
        nextState.codeReviewIdsWithActiveCommands.size ||
      this.state.codeReviewGroups?.length !=
        nextState.codeReviewGroups?.length ||
      this.state.searchEnabled != nextState.searchEnabled ||
      this.state.searchText != nextState.searchText ||
      this.state.selectedCodeReviewId != nextState.selectedCodeReviewId ||
      this.state.deleteDialogCodeReviews !==
        nextState.deleteDialogCodeReviews ||
      this.state.hiddenCodeReviewGroups.size !=
        nextState.hiddenCodeReviewGroups.size
    ) {
      return true;
    }

    // Sizes are equal at this point, so a one-directional membership check detects any
    // difference in which groups are collapsed
    for (const groupType of nextState.hiddenCodeReviewGroups) {
      if (!this.state.hiddenCodeReviewGroups.has(groupType)) {
        return true;
      }
    }

    for (const codeReviewId of this.state.codeReviewIdsWithActiveCommands) {
      beforeHash =
        ((beforeHash << 5) - beforeHash + hashCode(codeReviewId)) & 0xffffffff;
    }
    for (const codeReviewId of nextState.codeReviewIdsWithActiveCommands) {
      afterHash =
        ((afterHash << 5) - afterHash + hashCode(codeReviewId)) & 0xffffffff;
    }

    if (beforeHash != afterHash) {
      return true;
    }

    for (const codeReviewGroup of this.state.codeReviewGroups ?? []) {
      beforeHash =
        ((beforeHash << 5) -
          beforeHash +
          hashCode(codeReviewGroup.groupTypeStrWithoutOrderPrefix) +
          codeReviewGroup.sortedCodeReviews.length) &
        0xffffffff;
    }
    for (const codeReviewGroup of nextState.codeReviewGroups ?? []) {
      afterHash =
        ((afterHash << 5) -
          afterHash +
          hashCode(codeReviewGroup.groupTypeStrWithoutOrderPrefix) +
          codeReviewGroup.sortedCodeReviews.length) &
        0xffffffff;
    }

    if (beforeHash != afterHash) {
      return true;
    }

    // Signature of everything that affects how a row renders or how reviews
    // are ordered. Including the id makes the order-sensitive rolling hash
    // detect reorders (e.g. after a manual-weight change), and the remaining
    // fields catch changes that don't bump `lastRefreshedTimestamp`.
    const codeReviewSignature = (codeReview: CodeReview): string =>
      [
        codeReview.id,
        codeReview.status,
        codeReview.lastRefreshedTimestamp,
        codeReview.lastUpdatedTimestamp,
        codeReview.lastVisitedTimestamp,
        codeReview.lastChangedTimestamp,
        codeReview.lastMentionTimestamp,
        codeReview.snoozeUntilTimestamp,
        codeReview.snoozeUntilUpdatedAtChangedFrom,
        codeReview.hasManualWeightOverride,
        codeReview.manualWeightOverride,
        codeReview.githubFields?.status,
        codeReview.githubFields?.statusCheckRollupStatus,
        codeReview.githubFields?.isDraft,
        codeReview.githubFields?.willAutoMerge,
        codeReview.githubFields?.title,
        codeReview.githubFields?.url,
        codeReview.githubFields?.repo?.organizationName,
        codeReview.githubFields?.repo?.name,
        codeReview.githubFields?.number,
        codeReview.githubFields?.authorLogin,
        codeReview.githubFields?.approvedByLogins?.join(','),
        codeReview.renderOnlyFields.approvedBySelf,
        codeReview.renderOnlyFields.approvedByOthers,
        codeReview.renderOnlyFields.authorName,
        codeReview.renderOnlyFields.authorIsSelf,
        codeReview.renderOnlyFields.avatarUrl,
        codeReview.renderOnlyFields.weight,
      ].join('|');

    for (const codeReviewGroup of this.state.codeReviewGroups ?? []) {
      for (const codeReview of codeReviewGroup.sortedCodeReviews) {
        beforeHash =
          ((beforeHash << 5) -
            beforeHash +
            hashCode(codeReviewSignature(codeReview))) &
          0xffffffff;
      }
    }
    for (const codeReviewGroup of nextState.codeReviewGroups ?? []) {
      for (const codeReview of codeReviewGroup.sortedCodeReviews) {
        afterHash =
          ((afterHash << 5) -
            afterHash +
            hashCode(codeReviewSignature(codeReview))) &
          0xffffffff;
      }
    }

    if (beforeHash != afterHash) {
      return true;
    }

    return false;
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
      Math.max(10, Math.min(20, Math.floor(numCodeReviewsNeedingRefresh / 3))),
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

  isDeletable(codeReview: CodeReview): boolean {
    return (
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_CLOSED ||
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_MERGED ||
      codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_ARCHIVED ||
      codeReview.githubFields?.status ==
        GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_MERGED ||
      codeReview.githubFields?.status ==
        GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_CLOSED
    );
  }

  onIntervalBasedRefresh() {
    if (document.hidden || !(this.state.codeReviewsGrpcResult?.ok || false)) {
      return;
    }

    const nowTimestamp = Date.now() / 1000;

    if (nowTimestamp - this.lastAutoRelistTimestamp >= 300) {
      console.info('Re-listing code reviews');

      // Search for new code reviews which aren't listed yet
      this.lastAutoRelistTimestamp = nowTimestamp;
      this.relist();
      return;
    }

    // We keep a local map of when the last auto-refresh was tried for each code review. That's because the
    // stored state may not keep up with `onIntervalBasedRefresh` being called every second, and we don't want
    // to auto-refresh one code review multiple times just because its `lastRefreshedTimestamp` wasn't re-fetched
    // in the last few seconds.
    for (const [codeReviewId, localLastRefreshedTimestamp] of this
      .localLastRefreshedTimestampMap) {
      // We auto-refresh at most every 60 seconds (see `getAutoRefreshIntervalForSingleCodeReview`), so keep
      // the cache roughly until that time.
      if (nowTimestamp - localLastRefreshedTimestamp > 55) {
        this.localLastRefreshedTimestampMap.delete(codeReviewId);
      }
    }

    const codeReviewsNeedingRefresh =
      this.state.codeReviewGroups
        ?.map((codeReviewGroup) =>
          codeReviewGroup.sortedCodeReviews.filter((codeReview) => {
            return (
              nowTimestamp -
                (this.localLastRefreshedTimestampMap.get(codeReview.id) ?? 0) >
                55 &&
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
      `Auto-refresh with autoRefreshIntervalSeconds=${settings.autoRefreshIntervalSeconds} ` +
        `numCodeReviewsToRefresh=${settings.numCodeReviewsToRefresh} ` +
        `codeReviewsNeedingRefresh.length=${codeReviewsNeedingRefresh.length} ` +
        `this.numRunningAutoRefreshRequests=${this.numRunningAutoRefreshRequests}`,
    );

    const codeReviewIdsToRefresh = new Set<string>();

    for (let i = 0; i < settings.numCodeReviewsToRefresh; ++i) {
      for (let j = 0; j < 10; ++j) {
        // Give higher chances to top displayed code reviews
        const randomCodeReview = codeReviewsNeedingRefresh.at(
          codeReviewsNeedingRefresh.length * Math.pow(Math.random(), 1.2),
        );
        if (randomCodeReview === undefined) {
          break;
        }

        if (codeReviewIdsToRefresh.has(randomCodeReview.id)) {
          continue;
        }
        codeReviewIdsToRefresh.add(randomCodeReview.id);
        break;
      }
    }

    ++this.numRunningAutoRefreshRequests;
    if (this.numRunningAutoRefreshRequests > 2) {
      console.debug('Too many concurrent RPC requests, skipping auto-refresh');
      --this.numRunningAutoRefreshRequests;
      return;
    }

    for (const codeReviewIdToRefresh of codeReviewIdsToRefresh) {
      this.localLastRefreshedTimestampMap.set(
        codeReviewIdToRefresh,
        nowTimestamp,
      );
    }
    console.debug(
      `Refreshing ${codeReviewIdsToRefresh.size} code reviews: ${JSON.stringify([...codeReviewIdsToRefresh])}`,
    );

    this.runCommandOnManyCodeReviews(
      [...codeReviewIdsToRefresh],
      'refresh',
      (codeReviewIds, client, onResult) => {
        client.RefreshReviews(
          new RefreshReviewsCommand({
            codeReviewIds,
          }),
          grpcDeadline(grpcBatchTimeoutMs),
          (error, res) => {
            --this.numRunningAutoRefreshRequests;

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

  runCommandOnEachCodeReview(
    codeReviewIds: Array<string>,
    commandDesc: string,
    runCommand: (
      codeReviewId: string,
      client: WorkboardClient,
      onResult: (error: RpcError, res: CommandResponse) => void,
    ) => void,
  ) {
    const thiz = this;
    this.setState(
      (prevState) => ({
        codeReviewIdsWithActiveCommands: new Set([
          ...prevState.codeReviewIdsWithActiveCommands,
          ...codeReviewIds,
        ]),
      }),
      () => {
        let client = new WorkboardClient(grpcWebServerUrl);

        let numDone = 0;
        let timeoutAlerted = false;

        for (const codeReviewId of codeReviewIds) {
          runCommand(codeReviewId, client, (error, res) => {
            if (!this.mounted) {
              return;
            }

            const commandResult = toGrpcResult(error, res);
            if (!commandResult.ok) {
              console.error(
                `Command failed (${commandDesc}): ${commandResult.error}`,
              );

              if (!timeoutAlerted && isGrpcTimeout(commandResult.error)) {
                timeoutAlerted = true;
                alertCommandTimeout(commandDesc);
              }

              // Continue to refresh since that will remove the code review from `codeReviewIdsWithActiveCommands`
              // and after an error, it's probably a good idea to get the latest data.
            }

            ++numDone;
            if (numDone == codeReviewIds.length) {
              console.debug('Batch action done, getting code reviews list');
              thiz.refresh({
                removeCodeReviewIdsWithActiveCommands: codeReviewIds,
              });
            }
          });
        }
      },
    );
  }

  // Unlike the other `runCommand...` helpers, this one serves background
  // auto-refresh, so timeouts are only logged instead of interrupting the user
  runCommandOnManyCodeReviews(
    codeReviewIds: Array<string>,
    commandDesc: string,
    runCommand: (
      codeReviewIds: Array<string>,
      client: WorkboardClient,
      onResult: (error: RpcError, res: CommandResponse) => void,
    ) => void,
  ) {
    const thiz = this;
    this.setState(
      (prevState) => ({
        codeReviewIdsWithActiveCommands: new Set([
          ...prevState.codeReviewIdsWithActiveCommands,
          ...codeReviewIds,
        ]),
      }),
      () => {
        let client = new WorkboardClient(grpcWebServerUrl);

        runCommand(codeReviewIds, client, (error, res) => {
          if (!this.mounted) {
            return;
          }

          const commandResult = toGrpcResult(error, res);
          if (!commandResult.ok) {
            console.error(
              `Command failed (${commandDesc}): ${commandResult.error}`,
            );

            // Continue to refresh since that will remove the code reviews from `codeReviewIdsWithActiveCommands`
            // and after an error, it's probably a good idea to get the latest data.
          }

          thiz.refresh({
            removeCodeReviewIdsWithActiveCommands: codeReviewIds,
          });
        });
      },
    );
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
      (prevState) => ({
        codeReviewIdsWithActiveCommands: new Set([
          ...prevState.codeReviewIdsWithActiveCommands,
          codeReviewId,
        ]),
      }),
      () => {
        let client = new WorkboardClient(grpcWebServerUrl);
        runCommand(client, (error, res) => {
          if (!this.mounted) {
            return;
          }

          const commandResult = toGrpcResult(error, res);
          if (!commandResult.ok) {
            console.error(
              `Command failed (${commandDesc}): ${commandResult.error}`,
            );

            if (isGrpcTimeout(commandResult.error)) {
              alertCommandTimeout(commandDesc);
            }

            // Continue to refresh since that will remove the code review from `codeReviewIdsWithActiveCommands`
            // and after an error, it's probably a good idea to get the latest data.
          }

          thiz.refetchCodeReview(codeReviewId);
        });
      },
    );
  }

  onCloseDetailPane() {
    this.setState({ selectedCodeReviewId: undefined });
  }

  onCodeReviewRowKeyDown(event: KeyboardEvent, codeReviewId: string) {
    // Keys pressed on the row's links, buttons, and selects keep their meaning
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key == 'Enter' || event.key == ' ') {
      event.preventDefault();
      this.onSelectCodeReview(codeReviewId);
    }
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
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  onDeleteCodeReviewsWherePossible(event: Event) {
    event.preventDefault();

    // Match the count on the button, which respects the search filter
    const deleteDialogCodeReviews = [];
    for (const codeReviewGroup of this.state.codeReviewGroups ?? []) {
      for (const codeReview of codeReviewGroup.sortedCodeReviews) {
        if (
          codeReview.status != CodeReviewStatus.CODE_REVIEW_STATUS_DELETED &&
          (!this.state.searchEnabled ||
            this.searchTextMatchesCodeReview(codeReview)) &&
          this.isDeletable(codeReview)
        ) {
          deleteDialogCodeReviews.push(codeReview);
        }
      }
    }

    this.setState({ deleteDialogCodeReviews });
  }

  onDeleteDialogConfirmed() {
    const codeReviewIdsToDelete = (
      this.state.deleteDialogCodeReviews ?? []
    ).map((codeReview) => codeReview.id);

    this.runCommandOnEachCodeReview(
      codeReviewIdsToDelete,
      'delete review (batch)',
      (codeReviewId, client, onResult) => {
        client.DeleteReview(
          new DeleteReviewCommand({ codeReviewId: codeReviewId }),
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  onDocumentKeyDown = (event: KeyboardEvent) => {
    if (
      event.key != 'Escape' ||
      this.state.selectedCodeReviewId === undefined ||
      // Escape closes only the dialog
      this.state.deleteDialogCodeReviews !== undefined
    ) {
      return;
    }

    // Escape in form fields keeps its meaning, e.g. clearing the search
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    this.onCloseDetailPane();
  };

  onEnableSearch(event: Event) {
    event.preventDefault();

    this.setState(
      {
        searchEnabled: true,
      },
      () => {
        document.getElementById('search-text')?.focus();
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
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  onOpenDetailPane(codeReviewId: string) {
    this.setState({ selectedCodeReviewId: codeReviewId });
  }

  onRefresh(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'refresh',
      (client, onResult) => {
        client.RefreshReview(
          new RefreshReviewCommand({ codeReviewId }),
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  private onSetManualWeight(codeReview: CodeReview, event: Event) {
    event.preventDefault();
    const currentWeight = codeReview.renderOnlyFields.weight;
    const input = window.prompt(
      'Enter manual weight override (leave empty to clear):',
      currentWeight.toString(),
    );
    if (input === null) {
      return;
    }
    const trimmed = input.trim();
    let weightValue: number | undefined;
    if (trimmed === '') {
      weightValue = undefined;
    } else {
      const parsed = parseInt(trimmed, 10);
      if (isNaN(parsed)) {
        alert('Invalid weight. Please enter a number.');
        return;
      }
      weightValue = parsed;
    }

    this.runCommandOnSingleCodeReview(
      codeReview.id,
      'set manual weight',
      (client, onResult) => {
        client.SetCodeReviewManualWeight(
          new SetCodeReviewManualWeightCommand({
            codeReviewId: codeReview.id,
            manualWeightOverride: weightValue,
          }),
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  onRelist(event: Event) {
    event.preventDefault();

    this.relist();
  }

  onReviewedDeleteOnMerge(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'mark as reviewed, delete on merge',
      (client, onResult) => {
        client.ReviewedDeleteOnMerge(
          new ReviewedDeleteOnMergeCommand({ codeReviewId }),
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  onSearchTextChange(newSearchText: string) {
    // Disable and hide the search box if the user deletes the search text
    let searchEnabled = true;
    if (this.state.searchText != '' && newSearchText == '') {
      searchEnabled = false;
    }

    this.setState({
      searchEnabled,
      searchText: newSearchText,
    });
  }

  onSearchTextInputKeyDown(event: KeyboardEvent) {
    if (event.key == 'Escape') {
      this.setState({
        searchEnabled: false,
        searchText: '',
      });
    }
  }

  onSelectCodeReview(codeReviewId: string) {
    this.setState((prevState) => ({
      selectedCodeReviewId:
        prevState.selectedCodeReviewId == codeReviewId
          ? undefined
          : codeReviewId,
    }));
  }

  onSnoozeSelect(event: Event, codeReviewId: string) {
    event.preventDefault();

    const select = event.currentTarget as HTMLSelectElement;
    const value = select.value;
    select.selectedIndex = 0;

    if (value == snoozeUntilMentionedOptionValue) {
      this.onSnoozeUntilMentioned(event, codeReviewId);
      return;
    }
    if (value == snoozeUntilUpdateOptionValue) {
      this.onSnoozeUntilUpdate(event, codeReviewId);
      return;
    }

    const secondsFromNow = parseInt(value, 10);
    if (isNaN(secondsFromNow) || secondsFromNow <= 0) {
      throw new Error('Failed to get snooze time from select element');
    }
    this.onSnoozeUntilTime(event, codeReviewId, secondsFromNow);
  }

  onSnoozeUntilMentioned(event: Event, codeReviewId: string) {
    event.preventDefault();
    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'snooze until mentioned',
      (client, onResult) => {
        client.SnoozeUntilMentioned(
          new SnoozeUntilMentionedCommand({ codeReviewId }),
          grpcDeadline(grpcCommandTimeoutMs),
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
          grpcDeadline(grpcCommandTimeoutMs),
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
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  onToggleCodeReviewGroup(event: Event, groupType: CodeReviewGroupType) {
    event.preventDefault();

    const newHiddenCodeReviewGroups = new Set(
      this.state.hiddenCodeReviewGroups,
    );
    if (this.state.hiddenCodeReviewGroups.has(groupType)) {
      newHiddenCodeReviewGroups.delete(groupType);
    } else {
      newHiddenCodeReviewGroups.add(groupType);
    }

    this.setState({ hiddenCodeReviewGroups: newHiddenCodeReviewGroups });
  }

  onVisitReview(codeReviewId: string) {
    // NOT (we want the link click to behave as usual): event.preventDefault();

    this.runCommandOnSingleCodeReview(
      codeReviewId,
      'visit',
      (client, onResult) => {
        client.MarkVisited(
          new MarkVisitedCommand({ codeReviewId }),
          grpcDeadline(grpcCommandTimeoutMs),
          onResult,
        );
      },
    );
  }

  refetchCodeReview(codeReviewId: string) {
    let client = new WorkboardClient(grpcWebServerUrl);

    const thiz = this;
    const seq = ++this.getCodeReviewsSeq;
    client.GetCodeReviews(
      new GetCodeReviewsQuery(),
      grpcDeadline(grpcQueryTimeoutMs),
      (error, res) => {
        if (!this.mounted) {
          return;
        }

        const isStale = seq !== this.getCodeReviewsSeq;

        let codeReviewGroups: CodeReviewGroup[] | undefined =
          thiz.state.codeReviewGroups;
        if (!isStale && res !== null) {
          codeReviewGroups = sortCodeReviews(res);
        }

        thiz.setState((prevState): Partial<CodeReviewListState> => {
          const newCodeReviewIdsWithActiveCommands = new Set(
            prevState.codeReviewIdsWithActiveCommands,
          );
          newCodeReviewIdsWithActiveCommands.delete(codeReviewId);

          if (isStale) {
            // Only remove from active commands
            return {
              codeReviewIdsWithActiveCommands:
                newCodeReviewIdsWithActiveCommands,
            };
          }
          return {
            codeReviewGroups,
            codeReviewsGrpcResult: toGrpcResult(error, res),
            codeReviewIdsWithActiveCommands: newCodeReviewIdsWithActiveCommands,
          };
        });
      },
    );
  }

  refresh(opts?: { removeCodeReviewIdsWithActiveCommands?: Array<string> }) {
    const thiz = this;
    this.setState({ codeReviewsGrpcResult: makePendingGrpcResult() }, () => {
      let client = new WorkboardClient(grpcWebServerUrl);

      const seq = ++this.getCodeReviewsSeq;
      client.GetCodeReviews(
        new GetCodeReviewsQuery(),
        grpcDeadline(grpcQueryTimeoutMs),
        (error, res) => {
          if (!this.mounted) {
            return;
          }

          const isStale = seq !== this.getCodeReviewsSeq;

          let codeReviewGroups: CodeReviewGroup[] | undefined =
            thiz.state.codeReviewGroups;
          if (!isStale && res !== null) {
            codeReviewGroups = sortCodeReviews(res);
          }

          this.setState((prevState): Partial<CodeReviewListState> => {
            const newCodeReviewIdsWithActiveCommands = new Set(
              prevState.codeReviewIdsWithActiveCommands,
            );
            for (const codeReviewId of opts?.removeCodeReviewIdsWithActiveCommands ??
              []) {
              newCodeReviewIdsWithActiveCommands.delete(codeReviewId);
            }

            if (isStale) {
              // Only remove from active commands
              return {
                codeReviewIdsWithActiveCommands:
                  newCodeReviewIdsWithActiveCommands,
              };
            }
            return {
              codeReviewGroups,
              codeReviewIdsWithActiveCommands:
                newCodeReviewIdsWithActiveCommands,
              codeReviewsGrpcResult: toGrpcResult(error, res),
            };
          });
        },
      );
    });
  }

  relist() {
    let client = new WorkboardClient(grpcWebServerUrl);

    client.RelistReviews(
      new RelistReviewsCommand(),
      grpcDeadline(grpcBatchTimeoutMs),
      (error, res) => {
        if (!this.mounted) {
          return;
        }

        const commandResult = toGrpcResult(error, res);
        this.setState({
          relistCommandGrpcResult: commandResult,
        });
        if (!commandResult.ok) {
          console.error(
            `Command failed (RelistReviews): ${commandResult.error}`,
          );
          return;
        }

        this.refresh();
      },
    );
  }

  searchTextMatchesCodeReview(codeReview: CodeReview): boolean {
    const codeReviewDesc =
      (codeReview.githubFields?.url ?? '') +
      ' ' +
      (codeReview.githubFields?.title ?? '') +
      ' ' +
      (codeReview.renderOnlyFields.authorName ?? '');

    const searchWords = this.state.searchText
      .toLowerCase()
      .split(/\s+/)
      .filter((s) => s.trim().length > 0);
    if (searchWords.length == 0) {
      return true;
    }

    if (searchWords[0] == '!' && searchWords.length > 1) {
      // Negated search
      return !searchWords
        .slice(1)
        .every(
          (searchWord) =>
            codeReviewDesc.toLowerCase().indexOf(searchWord) !== -1,
        );
    } else {
      return searchWords.every(
        (searchWord) => codeReviewDesc.toLowerCase().indexOf(searchWord) !== -1,
      );
    }
  }

  render() {
    const nowTimestamp = Date.now() / 1000;

    // The ones to be rendered (can be filtered by search, deleted status, etc.).
    const codeReviewGroupsToRender: CodeReviewGroup[] = [];

    let numCodeReviews = 0;
    let numIgnoredCodeReviews = 0;
    let numSnoozedCodeReviews = 0;
    let numDeletableCodeReviews = 0;
    let selectedCodeReview: CodeReview | undefined;
    for (const codeReviewGroup of this.state.codeReviewGroups ?? []) {
      let haveCodeReviewsToRenderInThisGroup = false;

      for (const codeReview of codeReviewGroup.sortedCodeReviews) {
        if (codeReview.status == CodeReviewStatus.CODE_REVIEW_STATUS_DELETED) {
          continue;
        }
        // Keep the detail pane open even if the search hides its row
        if (codeReview.id == this.state.selectedCodeReviewId) {
          selectedCodeReview = codeReview;
        }
        if (
          this.state.searchEnabled &&
          !this.searchTextMatchesCodeReview(codeReview)
        ) {
          continue;
        }

        if (!haveCodeReviewsToRenderInThisGroup) {
          haveCodeReviewsToRenderInThisGroup = true;

          codeReviewGroupsToRender.push({
            groupType: codeReviewGroup.groupType,
            groupTypeStrWithoutOrderPrefix:
              codeReviewGroup.groupTypeStrWithoutOrderPrefix,
            sortedCodeReviews: [],
          });
        }

        codeReviewGroupsToRender[
          codeReviewGroupsToRender.length - 1
        ].sortedCodeReviews.push(codeReview);

        ++numCodeReviews;

        if (codeReview.renderOnlyFields.weight <= ignoredWeightThreshold) {
          ++numIgnoredCodeReviews;
        } else if (
          codeReview.status ==
            CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_MENTIONED ||
          codeReview.status ==
            CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_TIME ||
          codeReview.status ==
            CodeReviewStatus.CODE_REVIEW_STATUS_SNOOZED_UNTIL_UPDATE
        ) {
          ++numSnoozedCodeReviews;
        }

        if (this.isDeletable(codeReview)) {
          ++numDeletableCodeReviews;
        }
      }
    }

    return (
      <>
        {this.state.relistCommandGrpcResult?.error && (
          <ErrorBanner
            error={`Failed to refresh list of code reviews: ${this.state.relistCommandGrpcResult.error.message}`}
          />
        )}

        <div className="code-review-layout">
          <div className="code-review-list">
            <table className="pull-requests">
              <colgroup>
                <CodeReviewInfoColumns />
                <col className="pull-requests-shortcuts" />
              </colgroup>
              <thead>
                <tr>
                  <SignalColumnHeaders />
                  <th colSpan={3}>
                    Pull request
                    <div className="global-code-reviews-actions">
                      <button onClick={(event) => this.onRelist(event)}>
                        Refresh list
                      </button>
                      {numDeletableCodeReviews > 0 && (
                        <button
                          className="action-delete"
                          onClick={(event) =>
                            this.onDeleteCodeReviewsWherePossible(event)
                          }
                        >
                          Delete {numDeletableCodeReviews}{' '}
                          {simplePlural(numDeletableCodeReviews, 'code review')}
                        </button>
                      )}
                      {!this.state.searchEnabled && (
                        <button onClick={(event) => this.onEnableSearch(event)}>
                          🔍
                        </button>
                      )}
                      {this.state.searchEnabled && (
                        <input
                          type="text"
                          id="search-text"
                          className="search-text"
                          value={this.state.searchText}
                          // Filter code reviews list on every typed letter, no need
                          // for the user to press Enter key
                          onInput={(event) =>
                            this.onSearchTextChange(event.currentTarget.value)
                          }
                          onKeyDown={(event) =>
                            this.onSearchTextInputKeyDown(event)
                          }
                        />
                      )}
                      <span class="statistics">
                        {numCodeReviews -
                          numSnoozedCodeReviews -
                          numIgnoredCodeReviews}{' '}
                        {simplePlural(numCodeReviews, 'code review')} (
                        {numSnoozedCodeReviews} snoozed, {numIgnoredCodeReviews}{' '}
                        ignored, {numCodeReviews} total)
                      </span>
                      {this.state.codeReviewIdsWithActiveCommands.size > 0 && (
                        <Spinner />
                      )}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {this.state.codeReviewsGrpcResult?.pending && <Spinner />}
                {this.state.codeReviewsGrpcResult?.error && (
                  <tr>
                    <td colSpan={7}>
                      <ErrorBanner
                        error={`Failed to list code reviews: ${this.state.codeReviewsGrpcResult.error.message}`}
                      />
                    </td>
                  </tr>
                )}

                {this.state.codeReviewsGrpcResult?.ok &&
                  codeReviewGroupsToRender.map((codeReviewGroup) => (
                    <Fragment key={codeReviewGroup.groupType}>
                      <tr
                        className={`code-review-group code-review-group-type-${codeReviewGroup.groupTypeStrWithoutOrderPrefix}`}
                      >
                        <td colSpan={7}>
                          {
                            codeReviewGroupTypeHeaderDescription[
                              codeReviewGroup.groupType
                            ]
                          }
                          <span
                            title={`${codeReviewGroup.sortedCodeReviews.length} ${simplePlural(
                              codeReviewGroup.sortedCodeReviews.length,
                              'review',
                            )}`}
                          >
                            {' '}
                            ({codeReviewGroup.sortedCodeReviews.length})
                          </span>
                          <img
                            className="code-review-group-collapse-expand"
                            onClick={(event) =>
                              this.onToggleCodeReviewGroup(
                                event,
                                codeReviewGroup.groupType,
                              )
                            }
                            src={
                              this.state.hiddenCodeReviewGroups.has(
                                codeReviewGroup.groupType,
                              )
                                ? '/chevron-down.svg'
                                : '/chevron-up.svg'
                            }
                            title="Collapse/expand"
                          />
                        </td>
                      </tr>
                      {!this.state.hiddenCodeReviewGroups.has(
                        codeReviewGroup.groupType,
                      ) &&
                        codeReviewGroup.sortedCodeReviews.map((codeReview) => {
                          const hasActiveCommand =
                            this.state.codeReviewIdsWithActiveCommands.has(
                              codeReview.id,
                            );
                          const canSnooze =
                            canSnoozeUntilTimeOrUpdate(codeReview);

                          return (
                            <tr
                              key={codeReview.id}
                              className={`code-review status-${codeReviewStatusToString(codeReview.status)}${
                                nowTimestamp -
                                  codeReview.lastVisitedTimestamp <=
                                3600
                                  ? nowTimestamp -
                                      codeReview.lastVisitedTimestamp <=
                                    900
                                    ? ' very-recently-visited'
                                    : ' recently-visited'
                                  : nowTimestamp -
                                        codeReview.lastChangedTimestamp <=
                                      3600
                                    ? nowTimestamp -
                                        codeReview.lastChangedTimestamp <=
                                      900
                                      ? ' very-recently-changed'
                                      : ' recently-changed'
                                    : ''
                              }${codeReview.id == this.state.selectedCodeReviewId ? ' selected' : ''}`}
                              tabIndex={0}
                              onClick={() =>
                                this.onSelectCodeReview(codeReview.id)
                              }
                              onKeyDown={(event) =>
                                this.onCodeReviewRowKeyDown(
                                  event,
                                  codeReview.id,
                                )
                              }
                            >
                              <CodeReviewInfoCells
                                codeReview={codeReview}
                                hasActiveCommand={hasActiveCommand}
                                identityColor={safeColorForId(codeReview.id)}
                                onTitleClick={(event) => {
                                  // Open GitHub and show the detail pane without toggling it
                                  event.stopPropagation();
                                  this.onVisitReview(codeReview.id);
                                  this.onOpenDetailPane(codeReview.id);
                                }}
                              />
                              <td
                                className="code-review-shortcuts"
                                // Keep the detail pane as it is while using the shortcuts
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div
                                  className={`actions ${hasActiveCommand ? 'actions-disabled' : ''}`}
                                >
                                  {(canSnooze ||
                                    !codeReview.renderOnlyFields
                                      .authorIsSelf) && (
                                    <select
                                      aria-label="Snooze"
                                      onChange={(event) =>
                                        this.onSnoozeSelect(
                                          event,
                                          codeReview.id,
                                        )
                                      }
                                      disabled={hasActiveCommand}
                                    >
                                      <option value="">Snooze…</option>
                                      {canSnooze &&
                                        snoozeDurations.map(
                                          (snoozeDuration) => (
                                            <option
                                              key={snoozeDuration.seconds}
                                              value={snoozeDuration.seconds}
                                            >
                                              {snoozeDuration.label}
                                            </option>
                                          ),
                                        )}
                                      {canSnooze && (
                                        <option
                                          value={snoozeUntilUpdateOptionValue}
                                        >
                                          Until the PR is updated
                                        </option>
                                      )}
                                      {!codeReview.renderOnlyFields
                                        .authorIsSelf && (
                                        <option
                                          value={
                                            snoozeUntilMentionedOptionValue
                                          }
                                        >
                                          Until I'm mentioned (= someone else
                                          reviews)
                                        </option>
                                      )}
                                    </select>
                                  )}
                                  {canMarkReviewedDeleteOnMerge(codeReview) ? (
                                    <button
                                      className="action-reviewed-delete-on-merge"
                                      title="I reviewed or merged; delete once merged"
                                      onClick={(event) =>
                                        this.onReviewedDeleteOnMerge(
                                          event,
                                          codeReview.id,
                                        )
                                      }
                                      disabled={hasActiveCommand}
                                    >
                                      Reviewed
                                    </button>
                                  ) : (
                                    this.isDeletable(codeReview) && (
                                      <button
                                        className="action-delete"
                                        onClick={(event) =>
                                          this.onDeleteReview(
                                            event,
                                            codeReview.id,
                                          )
                                        }
                                        disabled={hasActiveCommand}
                                      >
                                        Delete
                                      </button>
                                    )
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
          {selectedCodeReview !== undefined && (
            <CodeReviewDetailPane
              codeReview={selectedCodeReview}
              gitHubStatus={gitHubPullRequestStatusToString(
                selectedCodeReview.githubFields?.status ??
                  GitHubPullRequestStatus.GITHUB_PULL_REQUEST_STATUS_UNSPECIFIED,
              )}
              hasActiveCommand={this.state.codeReviewIdsWithActiveCommands.has(
                selectedCodeReview.id,
              )}
              isDeletable={this.isDeletable(selectedCodeReview)}
              onClose={() => this.onCloseDetailPane()}
              onDelete={(event) =>
                this.onDeleteReview(event, selectedCodeReview.id)
              }
              onMarkMustReview={(event) =>
                this.onMarkMustReview(event, selectedCodeReview.id)
              }
              onRefresh={(event) =>
                this.onRefresh(event, selectedCodeReview.id)
              }
              onReviewedDeleteOnMerge={(event) =>
                this.onReviewedDeleteOnMerge(event, selectedCodeReview.id)
              }
              onSetManualWeight={(event) =>
                this.onSetManualWeight(selectedCodeReview, event)
              }
              onSnoozeUntilMentioned={(event) =>
                this.onSnoozeUntilMentioned(event, selectedCodeReview.id)
              }
              onSnoozeUntilTime={(event, secondsFromNow) =>
                this.onSnoozeUntilTime(
                  event,
                  selectedCodeReview.id,
                  secondsFromNow,
                )
              }
              onSnoozeUntilUpdate={(event) =>
                this.onSnoozeUntilUpdate(event, selectedCodeReview.id)
              }
              onVisit={() => this.onVisitReview(selectedCodeReview.id)}
              statusDescription={codeReviewStatusDescription(
                selectedCodeReview,
              )}
            />
          )}
        </div>

        {this.state.deleteDialogCodeReviews !== undefined && (
          <DeleteCodeReviewsDialog
            codeReviews={this.state.deleteDialogCodeReviews}
            onDelete={() => this.onDeleteDialogConfirmed()}
            onExited={() =>
              this.setState({ deleteDialogCodeReviews: undefined })
            }
          />
        )}
      </>
    );
  }
}
