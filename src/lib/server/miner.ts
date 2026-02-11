import { getStreamers } from './config';
import { twitchClient, encodeMinuteWatchedPayload, type StreamInfo } from './twitch';
import { twitchPubSub } from './pubsub';
import { twitchAuth } from './auth';
import { getLogger } from './logger';
import { eventStore } from './db/events';

const logger = getLogger('Miner');

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

interface ClaimAvailableData {
	claim: {
		id: string;
		channel_id: string;
	};
}

interface PointsEarnedData {
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

enum PubSubTopicType {
	CommunityPointsUser = 'community-points-user-v1',
	VideoPlaybackById = 'video-playback-by-id'
}

enum CommunityPointsMessageType {
	ClaimAvailable = 'claim-available',
	PointsEarned = 'points-earned'
}

enum VideoPlaybackMessageType {
	StreamUp = 'stream-up',
	StreamDown = 'stream-down',
	Viewcount = 'viewcount'
}

class MinerService {
	private interval: ReturnType<typeof setInterval> | null = null;
	private minuteWatcherInterval: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private startedAt: Date | null = null;
	private tickCount = 0;
	private lastTick: Date | null = null;
	private streamerStates: Map<string, StreamerState> = new Map();
	private userId: string | null = null;
	private lastStartResult: MinerStartResult | null = null;

	private readonly TICK_INTERVAL = 30 * 60_000; // 30 minutes -- PubSub handles real-time events
	private readonly MINUTE_WATCHED_INTERVAL = 20_000; // 20 seconds
	private readonly MAX_WATCHED_STREAMERS = 2;

	// message deduplication
	private lastMessageTimestamp = 0;
	private lastMessageIdentifier = '';

	private setStartResult(result: MinerStartResult): MinerStartResult {
		this.lastStartResult = result;
		return result;
	}

	private withEventStore(operation: string, action: () => void): void {
		try {
			action();
		} catch (error) {
			logger.error({ err: error, operation }, 'Failed to persist miner event');
		}
	}

	private cleanupFailedStart(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		if (this.minuteWatcherInterval) {
			clearInterval(this.minuteWatcherInterval);
			this.minuteWatcherInterval = null;
		}

		twitchPubSub.disconnect();
		this.withEventStore('run_stop_failed_start', () => {
			eventStore.stopRun('startup_failed');
		});
		this.running = false;
		this.startedAt = null;
		this.userId = null;
	}

	async start(): Promise<MinerStartResult> {
		if (this.running) {
			logger.info('Already running');
			return this.setStartResult({
				success: true,
				reason: 'already_running',
				message: 'Miner is already running'
			});
		}

		const authToken = twitchAuth.getAuthToken();
		if (!authToken) {
			logger.warn('Cannot start - no auth token configured');
			return this.setStartResult({
				success: false,
				reason: 'missing_token',
				message: 'Missing Twitch auth token'
			});
		}

		twitchClient.setAuthToken(authToken);
		twitchClient.setDeviceId(twitchAuth.getDeviceId());
		twitchPubSub.setAuthToken(authToken);

		// Validate token and get user ID
		const isValid = await twitchAuth.validateToken();
		if (!isValid) {
			logger.warn('Cannot start - invalid auth token');
			twitchAuth.logout();
			return this.setStartResult({
				success: false,
				reason: 'invalid_token',
				message: 'Invalid Twitch auth token'
			});
		}

		this.userId = twitchAuth.getUserId();
		this.withEventStore('run_start', () => {
			const authStatus = twitchAuth.getStatus();
			eventStore.startRun({
				startReason: 'started',
				userId: this.userId,
				username: authStatus.username
			});
		});

		this.running = true;
		this.startedAt = new Date();
		this.tickCount = 0;

		twitchPubSub.onMessage((topic, messageType, data) => {
			this.handlePubSubMessage(topic, messageType, data);
		});

		twitchPubSub.onConnected(() => {
			logger.debug('PubSub connected');
		});

		twitchPubSub.onDisconnected(() => {
			logger.debug('PubSub disconnected');
		});

		try {
			await twitchPubSub.connect();
		} catch (error) {
			logger.error({ err: error }, 'Failed to connect to PubSub');
			this.cleanupFailedStart();
			return this.setStartResult({
				success: false,
				reason: 'pubsub_connect_failed',
				message: 'Failed to connect to Twitch PubSub'
			});
		}

		try {
			logger.info('Setting up streamers...');

			await this.syncStreamers();
			await this.subscribeToPointsTopic();

			for (const [, state] of this.streamerStates) {
				if (state.channelId) {
					await this.subscribeToStreamer(state);
				}
			}

			// seed initial stream metadata and live status via API
			logger.info('Fetching initial stream info...');
			for (const [, state] of this.streamerStates) {
				if (state.channelId) {
					await this.checkStreamerOnline(state);
				}
			}

			logger.info('Starting context refresh loop...');

			// initial context refresh
			await this.tick();

			this.interval = setInterval(() => {
				this.tick().catch((err) => {
					logger.error({ err }, 'Tick error');
				});
			}, this.TICK_INTERVAL);

			logger.info('Starting minute-watched loop...');
			this.minuteWatcherInterval = setInterval(() => {
				this.sendMinuteWatchedForStreamers().catch((err) => {
					logger.error({ err }, 'Minute-watched loop error');
				});
			}, this.MINUTE_WATCHED_INTERVAL);
		} catch (error) {
			logger.error({ err: error }, 'Failed to finish miner startup');
			this.cleanupFailedStart();
			return this.setStartResult({
				success: false,
				reason: 'start_failed',
				message: 'Miner startup failed'
			});
		}

		logger.info({ streamerCount: this.streamerStates.size }, 'Started monitoring streamers');
		return this.setStartResult({
			success: true,
			reason: 'started',
			message: 'Miner started'
		});
	}

	stop(): void {
		if (!this.running) {
			logger.info('Not running');
			return;
		}

		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		if (this.minuteWatcherInterval) {
			clearInterval(this.minuteWatcherInterval);
			this.minuteWatcherInterval = null;
		}

		twitchPubSub.disconnect();
		this.withEventStore('run_stop', () => {
			eventStore.stopRun('stopped');
		});

		this.running = false;
		this.startedAt = null;
		this.userId = null;
		logger.info('Stopped');
	}

	private async syncStreamers(): Promise<void> {
		const streamers = getStreamers();

		// Add new streamers
		for (const name of streamers) {
			if (!this.streamerStates.has(name)) {
				// Get channel ID via GraphQL
				const channelId = await twitchClient.getUserId(name);

			this.streamerStates.set(name, {
				name,
				channelId,
				isLive: false,
				channelPoints: 0,
				startingPoints: null,
				offlineAt: 0,
				lastContextRefresh: 0,
				activeMultipliers: [],
				history: {},
				stream: createDefaultStreamData()
			});

				if (!channelId) {
					logger.warn({ streamer: name }, 'Could not get channel ID');
				}
			}

			const state = this.streamerStates.get(name);
			if (state) {
				this.withEventStore('register_streamer', () => {
					eventStore.registerStreamer({
						login: state.name,
						channelId: state.channelId
					});
				});
			}
		}

		// Remove streamers that are no longer in config
		for (const name of this.streamerStates.keys()) {
			if (!streamers.includes(name)) {
				this.streamerStates.delete(name);
			}
		}
	}

	private async subscribeToPointsTopic(): Promise<void> {
		if (!this.userId) {
			logger.warn('No user ID available - skipping user-level PubSub topic');
			logger.info('Claim bonuses will be detected via periodic channel points context checks');
			return;
		}

		try {
			await twitchPubSub.listen(`${PubSubTopicType.CommunityPointsUser}.${this.userId}`, true);
			logger.info({ userId: this.userId }, 'Subscribed to user-level channel points topic');
		} catch (error) {
			logger.error({ err: error }, 'Failed to subscribe to user topic');
			logger.warn('Claim bonuses will be detected via periodic channel points context checks');
		}
	}

	private async subscribeToStreamer(state: StreamerState): Promise<void> {
		if (!state.channelId) return;

		try {
			await twitchPubSub.listen(`${PubSubTopicType.VideoPlaybackById}.${state.channelId}`, false);
			logger.info({ streamer: state.name }, 'Subscribed to stream status');
		} catch (error) {
			logger.error({ err: error, streamer: state.name }, 'Failed to subscribe to streamer topic');
		}
	}

	private handlePubSubMessage(topic: string, messageType: string, data: unknown): void {
		const now = Date.now();
		const identifier = `${messageType}.${topic}`;
		if (identifier === this.lastMessageIdentifier && now - this.lastMessageTimestamp < 500) {
			logger.debug({ topic, messageType }, 'Skipping duplicate PubSub message');
			return;
		}
		this.lastMessageTimestamp = now;
		this.lastMessageIdentifier = identifier;

		const topicParts = topic.split('.');
		const topicType = topicParts[0];
		const topicId = topicParts[1];

		if (topicType === PubSubTopicType.CommunityPointsUser) {
			this.handleCommunityPointsMessage(messageType, data);
		} else if (topicType === PubSubTopicType.VideoPlaybackById) {
			this.handleVideoPlaybackMessage(topicId, messageType, data);
		}
	}

	private findStreamerByChannelId(channelId: string): StreamerState | undefined {
		for (const state of this.streamerStates.values()) {
			if (state.channelId === channelId) return state;
		}
	}

	private streamerContext(streamer?: StreamerState, channelId?: string | null) {
		const resolvedChannelId = channelId ?? streamer?.channelId;

		return {
			...(streamer?.name ? { streamer: streamer.name } : {}),
			...(resolvedChannelId ? { channelId: resolvedChannelId } : {})
		};
	}

	private handleCommunityPointsMessage(messageType: string, data: unknown): void {
		if (messageType === CommunityPointsMessageType.ClaimAvailable) {
			const claimData = data as { data: ClaimAvailableData };
			const { channel_id: channelId, id: claimId } = claimData.data.claim;
			const streamer = this.findStreamerByChannelId(channelId);
			const logContext = this.streamerContext(streamer, channelId);

			logger.info(logContext, 'Claim available');
			this.withEventStore('claim_available', () => {
				eventStore.recordEvent({
					streamer: {
						login: streamer?.name,
						channelId
					},
					eventType: 'claim_available',
					source: 'pubsub',
					claimId,
					payload: data
				});
			});
			this.claimBonus(channelId, claimId, 'pubsub');
		} else if (messageType === CommunityPointsMessageType.PointsEarned) {
			const pointsData = data as { data: PointsEarnedData };
			const { balance, point_gain } = pointsData.data;
			const channelId = pointsData.data.channel_id ?? balance.channel_id;
			const streamer = channelId ? this.findStreamerByChannelId(channelId) : undefined;

			logger.info(
				{
					...this.streamerContext(streamer, channelId),
					points: point_gain.total_points,
					reason: point_gain.reason_code,
					balance: balance.balance
				},
				'Points earned'
			);

			if (channelId) {
				this.withEventStore('points_earned', () => {
					eventStore.recordEvent({
						streamer: {
							login: streamer?.name,
							channelId
						},
						eventType: 'points_earned',
						source: 'pubsub',
						reasonCode: point_gain.reason_code,
						pointsDelta: point_gain.total_points,
						balanceAfter: balance.balance,
						payload: data
					});
				});
			}

			if (streamer) {
				streamer.channelPoints = balance.balance;

			if (point_gain.reason_code === 'WATCH_STREAK') {
				streamer.stream.watchStreakMissing = false;
			}

				const key = point_gain.reason_code;
				if (!streamer.history[key]) {
					streamer.history[key] = { counter: 0, amount: 0 };
				}
				streamer.history[key].counter++;
				streamer.history[key].amount += point_gain.total_points;
			}
		}
	}

	private handleVideoPlaybackMessage(
		channelId: string,
		messageType: string,
		data: unknown
	): void {
		const streamer = this.findStreamerByChannelId(channelId);
		if (!streamer) return;

		if (messageType === VideoPlaybackMessageType.StreamUp) {
			// record timestamp but do NOT mark live yet -- wait for viewcount verification
			streamer.stream.streamUpAt = Date.now();
			logger.debug({ streamer: streamer.name }, 'stream-up received, waiting for verification');
		} else if (messageType === VideoPlaybackMessageType.StreamDown) {
			const wasLive = streamer.isLive;
			const { title: previousTitle, game: previousGame, viewers: previousViewers, broadcastId: previousBroadcastId } = streamer.stream;

			if (streamer.isLive) {
				logger.info({ streamer: streamer.name }, 'Streamer went OFFLINE');
			}

			if (wasLive) {
				this.withEventStore('stream_down_pubsub', () => {
					eventStore.recordEvent({
						streamer: {
							login: streamer.name,
							channelId: streamer.channelId
						},
						eventType: 'stream_down',
						source: 'pubsub',
						broadcastId: previousBroadcastId,
						title: previousTitle,
						gameName: previousGame,
						viewersCount: previousViewers,
						payload: data
					});
				});
			}

			streamer.isLive = false;
			streamer.offlineAt = Date.now();
			streamer.stream = createDefaultStreamData();
		} else if (messageType === VideoPlaybackMessageType.Viewcount) {
			// update viewer count from PubSub data
			const viewData = data as { viewers?: number };
			if (viewData.viewers !== undefined) {
				streamer.stream.viewers = viewData.viewers;
			}

			if (
				!streamer.isLive &&
				Date.now() - streamer.stream.streamUpAt > 2 * 60_000
			) {
				this.checkStreamerOnline(streamer).catch((err) => {
					logger.error({ err, streamer: streamer.name }, 'Failed to check streamer online');
				});
			}
		}
	}

	private async checkStreamerOnline(state: StreamerState): Promise<void> {
		if (!state.channelId) return;

		if (state.offlineAt > 0 && Date.now() - state.offlineAt < 60_000) {
			logger.debug({ streamer: state.name }, 'Skipping online check (offline debounce)');
			return;
		}

		const streamInfo = await twitchClient.getStreamInfo(state.name);

		if (streamInfo) {
			this.applyStreamInfo(state, streamInfo);
			const wasOffline = !state.isLive;
			if (wasOffline) {
				state.isLive = true;
				state.stream.onlineAt = Date.now();
				state.stream.watchStreakMissing = true;
				state.stream.minuteWatched = 0;
				state.stream.minuteWatchedTimestamp = 0;
				this.withEventStore('stream_up_gql', () => {
					eventStore.recordEvent({
						streamer: {
							login: state.name,
							channelId: state.channelId
						},
						eventType: 'stream_up',
						source: 'gql_stream',
						broadcastId: state.stream.broadcastId,
						title: state.stream.title,
						gameName: state.stream.game,
						viewersCount: state.stream.viewers
					});
				});
				logger.info(
					{ streamer: state.name, title: state.stream.title, game: state.stream.game, viewers: state.stream.viewers },
					'Streamer went LIVE'
				);
			}

			// fetch spade URL if we don't have one (needed for minute-watched)
			if (!state.stream.spadeUrl) {
				const spadeUrl = await twitchClient.getSpadeUrl(state.name);
				if (spadeUrl) {
					state.stream.spadeUrl = spadeUrl;
				} else {
					logger.warn({ streamer: state.name }, 'Could not fetch spade URL');
				}
			}
		} else {
			if (state.isLive) {
				const { title: previousTitle, game: previousGame, viewers: previousViewers, broadcastId: previousBroadcastId } = state.stream;
				state.isLive = false;
				state.offlineAt = Date.now();
				this.withEventStore('stream_down_gql', () => {
					eventStore.recordEvent({
						streamer: {
							login: state.name,
							channelId: state.channelId
						},
						eventType: 'stream_down',
						source: 'gql_stream',
						broadcastId: previousBroadcastId,
						title: previousTitle,
						gameName: previousGame,
						viewersCount: previousViewers
					});
				});
				logger.info({ streamer: state.name }, 'Streamer went OFFLINE (verified via API)');
			}
			state.stream = createDefaultStreamData();
		}
	}

	private applyStreamInfo(state: StreamerState, info: StreamInfo): void {
		state.stream.broadcastId = info.broadcastId;
		state.stream.title = info.title;
		state.stream.game = info.game?.displayName ?? null;
		state.stream.viewers = info.viewersCount;
	}

	private async claimBonus(
		channelId: string,
		claimId: string,
		source: 'pubsub' | 'gql_context'
	): Promise<void> {
		const streamer = this.findStreamerByChannelId(channelId);
		const logContext = { ...this.streamerContext(streamer, channelId), claimId, source };
		this.withEventStore('claim_attempt', () => {
			eventStore.recordEvent({
				streamer: {
					login: streamer?.name,
					channelId
				},
				eventType: 'claim_attempt',
				source,
				claimId
			});
		});

		try {
			const result = await twitchClient.claimBonus(channelId, claimId);
			if (!result.ok) {
				this.withEventStore('claim_failed', () => {
					eventStore.recordEvent({
						streamer: {
							login: streamer?.name,
							channelId
						},
						eventType: 'claim_failed',
						source,
						claimId,
						payload: {
							reason: result.reason,
							...(result.errors ? { errors: result.errors } : {})
						}
					});
				});
				logger.warn({ ...logContext, reason: result.reason }, 'Failed to claim bonus');
				return;
			}

			this.withEventStore('claim_success', () => {
				eventStore.recordEvent({
					streamer: {
						login: streamer?.name,
						channelId
					},
					eventType: 'claim_success',
					source,
					claimId
				});
			});
			logger.info(logContext, 'Successfully claimed bonus');
		} catch (error) {
			this.withEventStore('claim_failed', () => {
				eventStore.recordEvent({
					streamer: {
						login: streamer?.name,
						channelId
					},
					eventType: 'claim_failed',
					source,
					claimId,
					payload: {
						reason: 'exception',
						error: String(error)
					}
				});
			});
			logger.error({ ...logContext, err: error }, 'Failed to claim bonus');
		}
	}

	private async tick(): Promise<void> {
		this.tickCount++;
		this.lastTick = new Date();

		logger.debug({ tick: this.tickCount, at: this.lastTick.toISOString() }, 'Tick');

		await this.syncStreamers();

		for (const [, state] of this.streamerStates) {
			await this.processStreamer(state);
		}
	}

	private async processStreamer(state: StreamerState): Promise<void> {
		state.lastContextRefresh = Date.now();

		if (!state.channelId) {
			logger.debug({ streamer: state.name }, 'Skipping streamer without channel ID');
			return;
		}

		// only refresh channel points context -- PubSub handles live status
		const context = await twitchClient.getChannelPointsContext(state.name);
		if (context) {
			if (state.startingPoints === null) {
				state.startingPoints = context.balance;
			}
			state.channelPoints = context.balance;
			state.activeMultipliers = context.activeMultipliers;
			this.withEventStore('context_snapshot', () => {
				eventStore.recordEvent({
					streamer: {
						login: state.name,
						channelId: state.channelId
					},
					eventType: 'context_snapshot',
					source: 'gql_context',
					balanceAfter: context.balance,
					payload: {
						activeMultipliers: context.activeMultipliers
					}
				});
			});

			if (context.availableClaimId && state.channelId) {
				logger.info({ streamer: state.name }, 'Found available claim via context check');
				this.withEventStore('claim_available_context', () => {
					eventStore.recordEvent({
						streamer: {
							login: state.name,
							channelId: state.channelId
						},
						eventType: 'claim_available',
						source: 'gql_context',
						claimId: context.availableClaimId
					});
				});
				await this.claimBonus(state.channelId, context.availableClaimId, 'gql_context');
			}
		}
	}

	// select up to MAX_WATCHED_STREAMERS online streamers to send minute-watched events for
	private selectStreamersToWatch(): StreamerState[] {
		const now = Date.now();
		const eligible: StreamerState[] = [];

		for (const [, state] of this.streamerStates) {
			if (
				state.isLive &&
				state.channelId &&
				state.stream.broadcastId &&
				state.stream.spadeUrl &&
				(state.stream.onlineAt === 0 || now - state.stream.onlineAt > 30_000)
			) {
				eligible.push(state);
			}
		}

		// default ORDER priority: take first N from config order
		const configOrder = getStreamers();
		eligible.sort((a, b) => {
			const aIdx = configOrder.indexOf(a.name);
			const bIdx = configOrder.indexOf(b.name);
			return (aIdx === -1 ? Infinity : aIdx) - (bIdx === -1 ? Infinity : bIdx);
		});

		return eligible.slice(0, this.MAX_WATCHED_STREAMERS);
	}

	/**
	 * core minute-watched loop body. Called every ~20 seconds.
	 * for each selected streamer: fetch playback token, resolve HLS stream URL,
	 * HEAD-verify it, then POST a minute-watched event to the spade endpoint.
	 */
	private async sendMinuteWatchedForStreamers(): Promise<void> {
		if (!this.userId) return;

		const now = Date.now();

		// refresh metadata for online streamers with stale data (>10 minutes)
		for (const [, state] of this.streamerStates) {
			if (state.isLive && state.channelId && now - state.lastContextRefresh > 10 * 60_000) {
				await this.checkStreamerOnline(state).catch((err) => {
					logger.error({ err, streamer: state.name }, 'Failed to refresh stale stream metadata');
				});
			}
		}

		const selected = this.selectStreamersToWatch();
		if (selected.length === 0) return;

		const delayBetween = this.MINUTE_WATCHED_INTERVAL / selected.length;

		for (let i = 0; i < selected.length; i++) {
			const state = selected[i];
			if (!state.channelId || !state.stream.broadcastId || !state.stream.spadeUrl) continue;

			try {
				const token = await twitchClient.getPlaybackAccessToken(state.name);
				if (!token) {
					logger.debug({ streamer: state.name }, 'Could not get playback token, skipping minute-watched');
					continue;
				}

				const streamUrl = await twitchClient.fetchLowestQualityStreamUrl(
					state.name,
					token.signature,
					token.value
				);
				if (!streamUrl) {
					logger.debug({ streamer: state.name }, 'Could not resolve stream URL, skipping minute-watched');
					continue;
				}

				const payload = encodeMinuteWatchedPayload(
					state.channelId,
					state.stream.broadcastId,
					this.userId,
					state.name
				);

				const success = await twitchClient.sendMinuteWatchedEvent(state.stream.spadeUrl, payload);
				if (success) {
					if (state.stream.minuteWatchedTimestamp > 0) {
						state.stream.minuteWatched += (now - state.stream.minuteWatchedTimestamp) / 60_000;
					}
					state.stream.minuteWatchedTimestamp = now;
					this.withEventStore('minute_watched_tick', () => {
						eventStore.recordEvent({
							streamer: {
								login: state.name,
								channelId: state.channelId
							},
							eventType: 'minute_watched_tick',
							source: 'spade',
							broadcastId: state.stream.broadcastId,
							viewersCount: state.stream.viewers,
							payload: {
								success: true,
								minuteWatched: Number(state.stream.minuteWatched.toFixed(2))
							}
						});
					});
					logger.debug(
						{ streamer: state.name, minuteWatched: state.stream.minuteWatched.toFixed(2) },
						'Sent minute-watched event'
					);
				} else {
					this.withEventStore('minute_watched_tick_failed', () => {
						eventStore.recordEvent({
							streamer: {
								login: state.name,
								channelId: state.channelId
							},
							eventType: 'minute_watched_tick',
							source: 'spade',
							broadcastId: state.stream.broadcastId,
							viewersCount: state.stream.viewers,
							payload: {
								success: false
							}
						});
					});
					logger.debug({ streamer: state.name }, 'Minute-watched POST did not return 204');
				}
			} catch (error) {
				logger.error({ err: error, streamer: state.name }, 'Error in minute-watched for streamer');
			}

			// space out requests between streamers (skip delay after last one)
			if (i < selected.length - 1) {
				await new Promise((resolve) => setTimeout(resolve, delayBetween));
			}
		}
	}

	getStatus(): MinerStatus {
		return {
			running: this.running,
			startedAt: this.startedAt,
			streamers: Array.from(this.streamerStates.values()),
			tickCount: this.tickCount,
			lastTick: this.lastTick,
			pubsubConnected: twitchPubSub.isConnectedToPubSub(),
			userId: this.userId
		};
	}

	isRunning(): boolean {
		return this.running;
	}

	getLastStartResult(): MinerStartResult | null {
		return this.lastStartResult;
	}
}

export const minerService = new MinerService();
