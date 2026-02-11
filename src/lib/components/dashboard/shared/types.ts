export type MinerLifecycle = 'running' | 'ready' | 'auth_required' | 'authenticating' | 'error';

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
	configuredStreamers: string[];
	streamerRuntimeStates: StreamerRuntimeState[];
}

export interface StreamerRuntimeState {
	login: string;
	isOnline: boolean;
	isWatched: boolean;
}

export type ChannelPointsSortBy = 'name' | 'points' | 'lastActive' | 'priority';
export type SortDir = 'asc' | 'desc';

export interface ChannelPointsControls {
	sortBy: ChannelPointsSortBy;
	sortDir: SortDir;
	rangeFromMs: number;
	rangeToMs: number;
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
			type: 'range';
			fromMs: number;
			toMs: number;
	  };

export interface StreamerAnalyticsItem {
	streamerId: number | null;
	login: string;
	latestBalance: number;
	pointsEarned: number;
	lastActiveAtMs: number | null;
}

export interface ChannelPointSample {
	timestampMs: number;
	balance: number;
}

export interface ChannelPointsAnalyticsSummary {
	trackedChannels: number;
	pointsEarnedThisSession: number;
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
	summary: ChannelPointsAnalyticsSummary;
	streamers: StreamerAnalyticsItem[];
	selectedStreamerLogin: string | null;
	timeline: ChannelPointSample[];
}
