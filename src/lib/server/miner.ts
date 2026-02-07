import { getStreamers } from './config';
import { twitchClient } from './twitch';
import { twitchPubSub } from './pubsub';
import { twitchAuth } from './auth';
import { getLogger } from './logger';

const logger = getLogger('Miner');

export interface StreamerState {
	name: string;
	channelId: string | null;
	isLive: boolean;
	lastChecked: Date | null;
	channelPoints: number;
	startingPoints: number | null;
	streamUpAt: Date | null;
	streamDownAt: Date | null;
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
	private running = false;
	private startedAt: Date | null = null;
	private tickCount = 0;
	private lastTick: Date | null = null;
	private streamerStates: Map<string, StreamerState> = new Map();
	private userId: string | null = null;
	private lastStartResult: MinerStartResult | null = null;

	private readonly TICK_INTERVAL = 60_000; // 60 seconds (less frequent since PubSub handles real-time events)

	private setStartResult(result: MinerStartResult): MinerStartResult {
		this.lastStartResult = result;
		return result;
	}

	private cleanupFailedStart(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		twitchPubSub.disconnect();
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

		this.running = true;
		this.startedAt = new Date();
		this.tickCount = 0;

		twitchPubSub.onMessage((topic, messageType, data) => {
			this.handlePubSubMessage(topic, messageType, data);
		});

		twitchPubSub.onConnected(() => {
			logger.info('PubSub connected');
		});

		twitchPubSub.onDisconnected(() => {
			logger.info('PubSub disconnected');
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

			logger.info('Starting background loop...');

			await this.tick();

			this.interval = setInterval(() => {
				this.tick().catch((err) => {
					logger.error({ err }, 'Tick error');
				});
			}, this.TICK_INTERVAL);
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

		twitchPubSub.disconnect();

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
					lastChecked: null,
					channelPoints: 0,
					startingPoints: null,
					streamUpAt: null,
					streamDownAt: null
				});

				if (!channelId) {
					logger.warn({ streamer: name }, 'Could not get channel ID');
				}
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

	private handleCommunityPointsMessage(messageType: string, data: unknown): void {
		if (messageType === CommunityPointsMessageType.ClaimAvailable) {
			const claimData = data as { data: ClaimAvailableData };
			const { channel_id: channelId, id: claimId } = claimData.data.claim;

			logger.info({ channelId }, 'Claim available');
			this.claimBonus(channelId, claimId);
		} else if (messageType === CommunityPointsMessageType.PointsEarned) {
			const pointsData = data as { data: PointsEarnedData };
			const { balance, point_gain } = pointsData.data;
			const channelId = pointsData.data.channel_id ?? balance.channel_id;

			logger.info(
				{ channelId, points: point_gain.total_points, reason: point_gain.reason_code, balance: balance.balance },
				'Points earned'
			);

			const streamer = channelId ? this.findStreamerByChannelId(channelId) : undefined;
			if (streamer) {
				streamer.channelPoints = balance.balance;
			}
		}
	}

	private handleVideoPlaybackMessage(
		channelId: string,
		messageType: string,
		_data: unknown
	): void {
		const streamer = this.findStreamerByChannelId(channelId);
		if (!streamer) return;

		if (messageType === VideoPlaybackMessageType.StreamUp) {
			streamer.streamUpAt = new Date();
			if (!streamer.isLive) {
				streamer.isLive = true;
				logger.info({ streamer: streamer.name }, 'Streamer went LIVE');
			}
		} else if (messageType === VideoPlaybackMessageType.StreamDown) {
			if (streamer.isLive) {
				streamer.isLive = false;
				streamer.streamDownAt = new Date();
				logger.info({ streamer: streamer.name }, 'Streamer went OFFLINE');
			}
		} else if (messageType === VideoPlaybackMessageType.Viewcount) {
			if (!streamer.isLive) {
				streamer.isLive = true;
				streamer.streamUpAt = new Date();
			}
		}
	}

	private async claimBonus(channelId: string, claimId: string): Promise<void> {
		try {
			const success = await twitchClient.claimBonus(channelId, claimId);
			if (success) {
				logger.info({ channelId }, 'Successfully claimed bonus');
			}
		} catch (error) {
			logger.error({ err: error, channelId }, 'Failed to claim bonus');
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
		state.lastChecked = new Date();

		if (!state.channelId) {
			logger.debug({ streamer: state.name }, 'Skipping streamer without channel ID');
			return;
		}

		const isLive = await twitchClient.isChannelLiveById(state.channelId);
		const wasLive = state.isLive;
		state.isLive = isLive;

		if (isLive && !wasLive) {
			state.streamUpAt = new Date();
			logger.info({ streamer: state.name }, 'Streamer went LIVE (detected via API)');
		} else if (!isLive && wasLive) {
			state.streamDownAt = new Date();
			logger.info({ streamer: state.name }, 'Streamer went OFFLINE (detected via API)');
		}

		// Check for available bonus claims (backup if PubSub misses it)
		if (isLive) {
			const context = await twitchClient.getChannelPointsContext(state.name);
			if (context) {
				if (state.startingPoints === null) {
					state.startingPoints = context.balance;
				}
				state.channelPoints = context.balance;

				if (context.availableClaimId && state.channelId) {
					logger.info({ streamer: state.name }, 'Found available claim via API check');
					await this.claimBonus(state.channelId, context.availableClaimId);
				}
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
