import { twitchClient, encodeMinuteWatchedPayload } from '$lib/server/twitch-client';
import { twitchPubSubPool } from '$lib/server/pubsub';
import { twitchAuth } from '$lib/server/auth';
import { getStreamers } from '$lib/server/config';
import { getLogger } from '$lib/server/logger';
import { eventStore } from '$lib/server/db/events';
import type { StreamerState, StreamerRuntimeState, MinerStatus, MinerStartResult } from './types';
import { handlePubSubMessage, type EventHandlerDeps, type MessageDedup } from './events';
import { diffWatchedLogins } from './watch-markers';
import {
	syncStreamers,
	subscribeToPointsTopic,
	subscribeToStreamer,
	checkStreamerOnline,
	selectStreamersToWatch,
	processStreamer,
	claimBonus,
	withEventStore
} from './streamers';

const logger = getLogger('Miner');

class MinerService {
	private interval: ReturnType<typeof setInterval> | null = null;
	private minuteWatcherInterval: ReturnType<typeof setInterval> | null = null;
	private starting = false;
	private running = false;
	private startedAt: Date | null = null;
	private tickCount = 0;
	private lastTick: Date | null = null;
	private streamerStates: Map<string, StreamerState> = new Map();
	private watchedStreamerNames = new Set<string>();
	private userId: string | null = null;
	private lastStartResult: MinerStartResult | null = null;

	private readonly TICK_INTERVAL = 30 * 60_000; // 30 minutes -- PubSub handles real-time events
	private readonly MINUTE_WATCHED_INTERVAL = 20_000; // 20 seconds
	private readonly MAX_WATCHED_STREAMERS = 2;

	// message deduplication
	private dedup: MessageDedup = {
		lastMessageTimestamp: 0,
		lastMessageIdentifier: ''
	};

	private setStartResult(result: MinerStartResult): MinerStartResult {
		this.lastStartResult = result;
		return result;
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

		this.persistWatchTransitions([]);
		twitchPubSubPool.disconnect();
		withEventStore('run_stop_failed_start', () => {
			eventStore.stopRun('startup_failed');
		});
		this.starting = false;
		this.running = false;
		this.startedAt = null;
		this.userId = null;
	}

	private persistWatchTransitions(nextWatchedStates: StreamerState[]): void {
		const nextWatchedStreamerNames = new Set(nextWatchedStates.map((state) => state.name));
		const { started, stopped } = diffWatchedLogins(this.watchedStreamerNames, nextWatchedStreamerNames);
		const watchedStreamerNames = Array.from(nextWatchedStreamerNames).sort((left, right) => left.localeCompare(right));
		const watchedCount = watchedStreamerNames.length;

		if (started.length === 0 && stopped.length === 0) {
			this.watchedStreamerNames = nextWatchedStreamerNames;
			return;
		}

		const occurredAtMs = Date.now();

		for (const login of stopped) {
			const state = this.streamerStates.get(login);
			withEventStore('watch_stopped', () => {
				eventStore.recordEvent({
					streamer: {
						login,
						channelId: state?.channelId
					},
					eventType: 'watch_stopped',
					source: 'system',
					occurredAtMs,
					broadcastId: state?.stream.broadcastId,
					viewersCount: state?.stream.viewers
				});
			});
			logger.info(
				{
					streamer: login,
					watchedCount,
					watchedLogins: watchedStreamerNames
				},
				'Watch stopped'
			);
		}

		for (const login of started) {
			const state = this.streamerStates.get(login);
			withEventStore('watch_started', () => {
				eventStore.recordEvent({
					streamer: {
						login,
						channelId: state?.channelId
					},
					eventType: 'watch_started',
					source: 'system',
					occurredAtMs,
					broadcastId: state?.stream.broadcastId,
					viewersCount: state?.stream.viewers
				});
			});
			logger.info(
				{
					streamer: login,
					watchedCount,
					watchedLogins: watchedStreamerNames
				},
				'Watch started'
			);
		}

		this.watchedStreamerNames = nextWatchedStreamerNames;
	}

	private getEventHandlerDeps(): EventHandlerDeps {
		return {
			streamerStates: this.streamerStates,
			dedup: this.dedup,
			claimBonus: (channelId, claimId, source) =>
				claimBonus(this.streamerStates, channelId, claimId, source),
			checkStreamerOnline: (state) => checkStreamerOnline(state)
		};
	}

	async start(): Promise<MinerStartResult> {
		if (this.running || this.starting) {
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

		this.starting = true;
		twitchClient.setAuthToken(authToken);
		twitchClient.setDeviceId(twitchAuth.getDeviceId());
		twitchPubSubPool.setAuthToken(authToken);

		// Validate token and get user ID
		const isValid = await twitchAuth.validateToken();
		if (!isValid) {
			logger.warn('Cannot start - invalid auth token');
			twitchAuth.logout();
			this.starting = false;
			return this.setStartResult({
				success: false,
				reason: 'invalid_token',
				message: 'Invalid Twitch auth token'
			});
		}

		this.userId = twitchAuth.getUserId();
		withEventStore('run_start', () => {
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

		const deps = this.getEventHandlerDeps();
		twitchPubSubPool.onMessage((topic, messageType, data) => {
			handlePubSubMessage(deps, topic, messageType, data);
		});

		twitchPubSubPool.onConnected(() => {
			logger.debug('PubSub connected');
		});

		twitchPubSubPool.onDisconnected(() => {
			logger.debug('PubSub disconnected');
		});

		try {
			await twitchPubSubPool.connect();
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

			await syncStreamers(this.streamerStates);
			await subscribeToPointsTopic(this.userId);

			for (const [, state] of this.streamerStates) {
				if (state.channelId) {
					await subscribeToStreamer(state);
				}
			}

			// seed initial stream metadata and live status via API
			logger.info('Fetching initial stream info...');
			for (const [, state] of this.streamerStates) {
				if (state.channelId) {
					await checkStreamerOnline(state);
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
		this.starting = false;
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

		this.persistWatchTransitions([]);
		twitchPubSubPool.disconnect();
		withEventStore('run_stop', () => {
			eventStore.stopRun('stopped');
		});

		this.starting = false;
		this.running = false;
		this.startedAt = null;
		this.userId = null;
		logger.info('Stopped');
	}

	private async tick(): Promise<void> {
		this.tickCount++;
		this.lastTick = new Date();

		logger.debug({ tick: this.tickCount, at: this.lastTick.toISOString() }, 'Tick');

		await syncStreamers(this.streamerStates);

		for (const [, state] of this.streamerStates) {
			await processStreamer(this.streamerStates, state);
		}
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
				await checkStreamerOnline(state).catch((err) => {
					logger.error({ err, streamer: state.name }, 'Failed to refresh stale stream metadata');
				});
			}
		}

		const selectedStreamers = selectStreamersToWatch(this.streamerStates, this.MAX_WATCHED_STREAMERS);
		this.persistWatchTransitions(selectedStreamers);
		if (selectedStreamers.length === 0) return;

		const delayBetween = this.MINUTE_WATCHED_INTERVAL / selectedStreamers.length;

		for (let i = 0; i < selectedStreamers.length; i++) {
			const streamerState = selectedStreamers[i];
			if (!streamerState.channelId || !streamerState.stream.broadcastId || !streamerState.stream.spadeUrl) continue;

			try {
				const token = await twitchClient.getPlaybackAccessToken(streamerState.name);
				if (!token) {
					logger.debug({ streamer: streamerState.name }, 'Could not get playback token, skipping minute-watched');
					continue;
				}

				const streamUrl = await twitchClient.fetchLowestQualityStreamUrl(
					streamerState.name,
					token.signature,
					token.value
				);
				if (!streamUrl) {
					logger.debug({ streamer: streamerState.name }, 'Could not resolve stream URL, skipping minute-watched');
					continue;
				}

				const payload = encodeMinuteWatchedPayload(
					streamerState.channelId,
					streamerState.stream.broadcastId,
					this.userId,
					streamerState.name
				);

				const success = await twitchClient.sendMinuteWatchedEvent(streamerState.stream.spadeUrl, payload);
				if (success) {
					if (streamerState.stream.minuteWatchedTimestamp > 0) {
						streamerState.stream.minuteWatched += (now - streamerState.stream.minuteWatchedTimestamp) / 60_000;
					}
					streamerState.stream.minuteWatchedTimestamp = now;
					logger.debug(
						{ streamer: streamerState.name, minuteWatched: streamerState.stream.minuteWatched.toFixed(2) },
						'Sent minute-watched event'
					);
				} else {
					withEventStore('minute_watched_tick_failed', () => {
						eventStore.recordEvent({
							streamer: {
								login: streamerState.name,
								channelId: streamerState.channelId
							},
							eventType: 'minute_watched_tick_failed',
							source: 'spade',
							broadcastId: streamerState.stream.broadcastId,
							viewersCount: streamerState.stream.viewers,
							payload: {
								success: false
							}
						});
					});
					logger.debug({ streamer: streamerState.name }, 'Minute-watched POST did not return 204');
				}
			} catch (error) {
				logger.error({ err: error, streamer: streamerState.name }, 'Error in minute-watched for streamer');
			}

			// space out requests between streamers (skip delay after last one)
			if (i < selectedStreamers.length - 1) {
				await new Promise((resolve) => setTimeout(resolve, delayBetween));
			}
		}
	}

	getStatus(): MinerStatus {
		return {
			starting: this.starting,
			running: this.running,
			startedAt: this.startedAt,
			streamers: Array.from(this.streamerStates.values()),
			tickCount: this.tickCount,
			lastTick: this.lastTick,
			pubsubConnected: twitchPubSubPool.isConnectedToPubSub(),
			userId: this.userId
		};
	}

	getStreamerRuntimeStates(): StreamerRuntimeState[] {
		const configuredStreamers = getStreamers();
		if (!this.running) {
			return configuredStreamers.map((login) => ({
				login,
				isOnline: false,
				isWatched: false
			}));
		}

		const watched = new Set(
			selectStreamersToWatch(this.streamerStates, this.MAX_WATCHED_STREAMERS).map((streamer) => streamer.name)
		);

		return configuredStreamers.map((login) => {
			const state = this.streamerStates.get(login);
			return {
				login,
				isOnline: Boolean(state?.isLive),
				isWatched: watched.has(login)
			};
		});
	}

	getRuntimeBalanceByLogin(): ReadonlyMap<string, number> {
		if (!this.running) return new Map();

		const balances = new Map<string, number>();
		for (const login of getStreamers()) {
			const state = this.streamerStates.get(login);
			if (!state || state.lastContextRefresh === 0) continue;
			balances.set(login, state.channelPoints);
		}

		return balances;
	}

	getLastStartResult(): MinerStartResult | null {
		return this.lastStartResult;
	}
}

export const minerService = new MinerService();
