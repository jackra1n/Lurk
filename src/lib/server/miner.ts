import { getStreamers } from './config';
import { twitchClient } from './twitch';
import { twitchPubSub } from './pubsub';
import { twitchAuth } from './auth';

export interface StreamerState {
	name: string;
	channelId: string | null;
	isLive: boolean;
	lastChecked: Date | null;
	channelPoints: number;
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

interface ClaimAvailableData {
	claim: {
		id: string;
		channel_id: string;
	};
}

interface PointsEarnedData {
	balance: {
		balance: number;
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

	private readonly TICK_INTERVAL = 60_000; // 60 seconds (less frequent since PubSub handles real-time events)

	async start(): Promise<void> {
		if (this.running) {
			console.log('[Miner] Already running');
			return;
		}

		const authToken = twitchAuth.getAuthToken();
		if (!authToken) {
			console.log('[Miner] Cannot start - no auth token configured');
			return;
		}

		twitchClient.setAuthToken(authToken);
		twitchPubSub.setAuthToken(authToken);

		// Validate token and get user ID
		const isValid = await twitchAuth.validateToken();
		if (!isValid) {
			console.log('[Miner] Cannot start - invalid auth token');
			return;
		}

		this.userId = twitchAuth.getUserId();

		this.running = true;
		this.startedAt = new Date();
		this.tickCount = 0;

		twitchPubSub.onMessage((topic, messageType, data) => {
			this.handlePubSubMessage(topic, messageType, data);
		});

		twitchPubSub.onConnected(() => {
			console.log('[Miner] PubSub connected');
		});

		twitchPubSub.onDisconnected(() => {
			console.log('[Miner] PubSub disconnected');
		});

		try {
			await twitchPubSub.connect();
		} catch (error) {
			console.error('[Miner] Failed to connect to PubSub:', error);
			this.running = false;
			return;
		}

		console.log('[Miner] Setting up streamers...');

		await this.syncStreamers();
		await this.subscribeToPointsTopic();

		for (const [, state] of this.streamerStates) {
			if (state.channelId) {
				await this.subscribeToStreamer(state);
			}
		}

		console.log('[Miner] Starting background loop...');

		await this.tick();

		this.interval = setInterval(() => {
			this.tick().catch((err) => {
				console.error('[Miner] Tick error:', err);
			});
		}, this.TICK_INTERVAL);

		console.log(`[Miner] Started. Monitoring ${this.streamerStates.size} streamers.`);
	}

	stop(): void {
		if (!this.running) {
			console.log('[Miner] Not running');
			return;
		}

		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}

		twitchPubSub.disconnect();

		this.running = false;
		console.log('[Miner] Stopped');
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
					channelPoints: 0
				});

				if (!channelId) {
					console.error(`[Miner] Could not get channel ID for ${name}`);
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
			console.log('[Miner] No user ID available - skipping user-level PubSub topic');
			console.log('[Miner] Claim bonuses will be detected via periodic channel points context checks');
			return;
		}

		try {
			await twitchPubSub.listen(`${PubSubTopicType.CommunityPointsUser}.${this.userId}`, true);
			console.log(`[Miner] Subscribed to user-level channel points topic for user ${this.userId}`);
		} catch (error) {
			console.error('[Miner] Failed to subscribe to user topic:', error);
			console.log('[Miner] Claim bonuses will be detected via periodic channel points context checks');
		}
	}

	private async subscribeToStreamer(state: StreamerState): Promise<void> {
		if (!state.channelId) return;

		try {
			await twitchPubSub.listen(`${PubSubTopicType.VideoPlaybackById}.${state.channelId}`, false);
			console.log(`[Miner] Subscribed to ${state.name}'s stream status`);
		} catch (error) {
			console.error(`[Miner] Failed to subscribe to ${state.name}:`, error);
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

	private handleCommunityPointsMessage(messageType: string, data: unknown): void {
		if (messageType === CommunityPointsMessageType.ClaimAvailable) {
			const claimData = data as { data: ClaimAvailableData };
			const { channel_id: channelId, id: claimId } = claimData.data.claim;

			console.log(`[Miner] Claim available for channel ${channelId}!`);
			this.claimBonus(channelId, claimId);
		} else if (messageType === CommunityPointsMessageType.PointsEarned) {
			const pointsData = data as { data: PointsEarnedData };
			const { balance, point_gain } = pointsData.data;

			console.log(
				`[Miner] +${point_gain.total_points} points (${point_gain.reason_code}), Balance: ${balance.balance}`
			);
		}
	}

	private handleVideoPlaybackMessage(
		channelId: string,
		messageType: string,
		_data: unknown
	): void {
		let streamer: StreamerState | undefined;
		for (const state of this.streamerStates.values()) {
			if (state.channelId === channelId) {
				streamer = state;
				break;
			}
		}

		if (!streamer) return;

		if (messageType === VideoPlaybackMessageType.StreamUp) {
			if (!streamer.isLive) {
				streamer.isLive = true;
				console.log(`[Miner] ${streamer.name} went LIVE`);
			}
		} else if (messageType === VideoPlaybackMessageType.StreamDown) {
			if (streamer.isLive) {
				streamer.isLive = false;
				console.log(`[Miner] ${streamer.name} went OFFLINE`);
			}
		} else if (messageType === VideoPlaybackMessageType.Viewcount) {
			if (!streamer.isLive) {
				streamer.isLive = true;
			}
		}
	}

	private async claimBonus(channelId: string, claimId: string): Promise<void> {
		try {
			const success = await twitchClient.claimBonus(channelId, claimId);
			if (success) {
				console.log(`[Miner] Successfully claimed bonus for channel ${channelId}`);
			}
		} catch (error) {
			console.error(`[Miner] Failed to claim bonus:`, error);
		}
	}

	private async tick(): Promise<void> {
		this.tickCount++;
		this.lastTick = new Date();

		console.log(`[Miner] Tick #${this.tickCount} at ${this.lastTick.toISOString()}`);

		await this.syncStreamers();

		for (const [, state] of this.streamerStates) {
			await this.processStreamer(state);
		}
	}

	private async processStreamer(state: StreamerState): Promise<void> {
		state.lastChecked = new Date();

		if (!state.channelId) {
			console.log(`[Miner] Skipping ${state.name} - no channel ID`);
			return;
		}

		const isLive = await twitchClient.isChannelLiveById(state.channelId);
		const wasLive = state.isLive;
		state.isLive = isLive;

		if (isLive && !wasLive) {
			console.log(`[Miner] ${state.name} went LIVE (detected via API)`);
		} else if (!isLive && wasLive) {
			console.log(`[Miner] ${state.name} went OFFLINE (detected via API)`);
		}

		// Check for available bonus claims (backup if PubSub misses it)
		if (isLive) {
			const context = await twitchClient.getChannelPointsContext(state.name);
			if (context) {
				state.channelPoints = context.balance;

				if (context.availableClaimId && state.channelId) {
					console.log(`[Miner] Found available claim for ${state.name} via API check`);
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
}

export const minerService = new MinerService();
