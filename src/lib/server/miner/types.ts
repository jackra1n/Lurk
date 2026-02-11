export interface StreamData {
	broadcastId: string | null;
	title: string | null;
	game: string | null;
	viewers: number;
	spadeUrl: string | null;
	streamUpAt: number; // PubSub stream-up timestamp, 0 = unset
	onlineAt: number; // confirmed online, used for 30-second grace period
	minuteWatched: number;
	minuteWatchedTimestamp: number;
	watchStreakMissing: boolean;
}

export function createDefaultStreamData(): StreamData {
	return {
		broadcastId: null,
		title: null,
		game: null,
		viewers: 0,
		spadeUrl: null,
		streamUpAt: 0,
		onlineAt: 0,
		minuteWatched: 0,
		minuteWatchedTimestamp: 0,
		watchStreakMissing: false
	};
}

export interface StreamerState {
	name: string;
	channelId: string | null;
	isLive: boolean;
	channelPoints: number;
	startingPoints: number | null;
	offlineAt: number; // confirmed offline, used for 60-second debounce
	lastContextRefresh: number; // epoch ms
	activeMultipliers: { factor: number }[];
	history: Record<string, { counter: number; amount: number }>;
	stream: StreamData;
}

export interface MinerStatus {
	running: boolean;
	startedAt: Date | null;
	streamers: StreamerState[];
	tickCount: number;
	lastTick: Date | null;
	pubsubConnected: boolean;
	userId: string | null;
}

export type MinerStartReason =
	| 'started'
	| 'already_running'
	| 'missing_token'
	| 'invalid_token'
	| 'pubsub_connect_failed'
	| 'start_failed';

export interface MinerStartResult {
	success: boolean;
	reason: MinerStartReason;
	message: string;
}

export interface ClaimAvailableData {
	claim: {
		id: string;
		channel_id: string;
	};
}

export interface PointsEarnedData {
	channel_id: string;
	balance: {
		balance: number;
		channel_id: string;
	};
	point_gain: {
		total_points: number;
		reason_code: string;
	};
}

export enum PubSubTopicType {
	CommunityPointsUser = 'community-points-user-v1',
	VideoPlaybackById = 'video-playback-by-id'
}

export enum CommunityPointsMessageType {
	ClaimAvailable = 'claim-available',
	PointsEarned = 'points-earned'
}

export enum VideoPlaybackMessageType {
	StreamUp = 'stream-up',
	StreamDown = 'stream-down',
	Viewcount = 'viewcount'
}

export function findStreamerByChannelId(
	streamerStates: Map<string, StreamerState>,
	channelId: string
): StreamerState | undefined {
	for (const state of streamerStates.values()) {
		if (state.channelId === channelId) return state;
	}
}

export function streamerContext(streamer?: StreamerState, channelId?: string | null) {
	const resolvedChannelId = channelId ?? streamer?.channelId;
	return {
		...(streamer?.name ? { streamer: streamer.name } : {}),
		...(resolvedChannelId ? { channelId: resolvedChannelId } : {})
	};
}
