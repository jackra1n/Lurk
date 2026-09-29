export type MinerLifecycle = 'starting' | 'running' | 'ready' | 'auth_required' | 'authenticating' | 'error';
export type DashboardNoticeState = { kind: 'error' | 'success'; text: string };

export type LifecycleReason = 'missing_token' | 'invalid_token' | 'auth_pending' | 'startup_failed' | null;

export interface AuthStatusResponse {
  authenticated: boolean;
  userId: string | null;
  username: string | null;
  pendingLogin: boolean;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
}

export interface MinerStatusResponse {
  running: boolean;
  lifecycle: MinerLifecycle;
  reason: LifecycleReason;
  startedAtMs: number | null;
  configuredStreamers: string[];
  streamerRuntimeStates: StreamerRuntimeState[];
}

export interface StreamerRuntimeState {
  login: string;
  isOnline: boolean;
  isWatched: boolean;
  channelPointsDisabled: boolean;
  multiplier: number | null;
}

export type ChannelPointsSortBy = 'name' | 'points' | 'lastActive' | 'lastWatched' | 'priority';
export type SortDir = 'asc' | 'desc';
export type ChannelPointsRangeSelection = '24h' | '7d' | '30d' | 'calendar';

export interface ChannelPointsControls {
  sortBy: ChannelPointsSortBy;
  sortDir: SortDir;
  rangeFromMs: number;
  rangeToMs: number;
  rangeSelection: ChannelPointsRangeSelection;
  allChannels: boolean;
}

export type ChannelPointsControlChange =
  | {
      type: 'sortBy';
      value: ChannelPointsSortBy;
    }
  | {
      type: 'toggleSortDir';
    }
  | {
      type: 'selectStreamer';
      login: string;
    }
  | {
      type: 'selectAll';
    }
  | {
      type: 'range';
      fromMs: number;
      toMs: number;
      selection: ChannelPointsRangeSelection;
    };

export interface StreamerAnalyticsItem {
  streamerId: number | null;
  login: string;
  displayName: string | null;
  profileImageUrl: string | null;
  latestBalance: number;
  pointsEarned: number;
  lastActiveAtMs: number | null;
  lastWatchedAtMs: number | null;
}

export interface ChannelPointSample {
  timestampMs: number;
  balance: number;
}

export interface TimeRange {
  fromMs: number;
  toMs: number;
}

export interface ChannelPointsAnalyticsResponse {
  success: boolean;
  range: {
    fromMs: number;
    toMs: number;
  };
  sort: {
    by: ChannelPointsSortBy;
    dir: SortDir;
  };
  streamers: StreamerAnalyticsItem[];
  selectedStreamerLogin: string | null;
  timeline: ChannelPointSample[];
  periods: {
    live: TimeRange[];
    watched: TimeRange[];
  };
  earnings: EarningsBuckets | null;
}

export interface EarningsBucket extends EarningsBreakdown {
  startMs: number;
}

export interface EarningsBuckets {
  bucketMs: number;
  buckets: EarningsBucket[];
}

export type ActivityFeedItem =
  | {
      kind: 'watch';
      id: string;
      login: string;
      occurredAtMs: number;
      durationMs: number;
      points: number;
      streak: boolean;
      ongoing: boolean;
    }
  | {
      kind: 'online';
      id: string;
      login: string;
      occurredAtMs: number;
      game: string | null;
    }
  | {
      kind: 'offline' | 'claim_failed';
      id: string;
      login: string;
      occurredAtMs: number;
    };

export interface MissedTimeItem {
  login: string;
  liveMs: number;
  watchedMs: number;
  missedPoints: number | null;
}

export interface StreamerActivityResponse {
  success: boolean;
  days: number;
  feed: ActivityFeedItem[];
  missed: MissedTimeItem[];
}

export interface WatchingStreamer {
  login: string;
  game: string | null;
  title: string | null;
  viewers: number;
  watchingSinceMs: number | null;
  points: number;
  streak: boolean;
}

export interface EarningsBreakdown {
  total: number;
  watch: number;
  claim: number;
  streak: number;
  other: number;
}

export interface DashboardSummaryResponse {
  success: boolean;
  watching: WatchingStreamer[];
  earnings: {
    last24h: EarningsBreakdown;
    dailyAverage: number | null;
    allTime: number;
    sinceMs: number | null;
  };
}
