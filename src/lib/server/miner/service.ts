import { twitchClient, encodeMinuteWatchedPayload } from '$lib/server/twitch-client';
import { twitchPubSubPool } from '$lib/server/pubsub';
import { twitchAuth } from '$lib/server/auth';
import { getStreamers } from '$lib/server/config';
import { getLogger } from '$lib/server/logger';
import { eventStore } from '$lib/server/db/events';
import type { StreamerState, StreamerRuntimeState, MinerStatus, MinerStartResult, WatchedStream } from './types';
import { handlePubSubMessage, type EventHandlerDeps, type MessageDedup } from './events';
import { diffWatchedLogins } from './watch-markers';
import {
  syncStreamers,
  subscribeToPointsTopic,
  subscribeToStreamer,
  checkStreamerOnline,
  isMetadataCheckDue,
  invalidateStreamMetadata,
  selectStreamersToWatch,
  selectDueStreamers,
  processStreamer,
  claimBonus,
  withEventStore
} from './streamers';

const logger = getLogger('Miner');

export class MinerService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private watchLoopTimeout: ReturnType<typeof setTimeout> | null = null;
  private watchLoopGeneration = 0;
  private metadataInterval: ReturnType<typeof setInterval> | null = null;
  private metadataLoopGeneration = 0;
  private metadataCheck: Promise<void> | null = null;
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
  private readonly WATCH_LOOP_INTERVAL = 20_000;
  private readonly METADATA_CHECK_INTERVAL = 1_000;
  private readonly MINUTE_WATCHED_INTERVAL = 59_000;
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
    this.invalidateWatchLoop();
    this.invalidateMetadataLoop();

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
      claimBonus: (channelId, claimId, source) => claimBonus(this.streamerStates, channelId, claimId, source)
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
    const generation = this.metadataLoopGeneration;

    const deps = this.getEventHandlerDeps();
    twitchPubSubPool.onMessage((topic, messageType, data) => {
      if (!this.running || generation !== this.metadataLoopGeneration) return;
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
      if (generation === this.metadataLoopGeneration) this.cleanupFailedStart();
      return this.setStartResult({
        success: false,
        reason: 'pubsub_connect_failed',
        message: 'Failed to connect to Twitch PubSub'
      });
    }

    try {
      logger.info('Setting up streamers...');

      await syncStreamers(this.streamerStates);
      if (!this.running || generation !== this.metadataLoopGeneration) {
        throw new Error('Miner startup interrupted');
      }
      subscribeToPointsTopic(this.userId);

      for (const [, state] of this.streamerStates) {
        if (state.channelId) {
          subscribeToStreamer(state);
        }
      }

      if (!this.running || generation !== this.metadataLoopGeneration) {
        throw new Error('Miner startup interrupted');
      }
      // Metadata discovery and recovery run independently of watch telemetry.
      this.startMetadataLoop();
      logger.info('Starting minute-watched loop...');
      this.startWatchLoop();

      logger.info('Starting context refresh loop...');

      // initial context refresh
      await this.tick();
      if (!this.running || generation !== this.metadataLoopGeneration) {
        throw new Error('Miner startup interrupted');
      }

      this.interval = setInterval(() => {
        this.tick().catch((err) => {
          logger.error({ err }, 'Tick error');
        });
      }, this.TICK_INTERVAL);
    } catch (error) {
      logger.error({ err: error }, 'Failed to finish miner startup');
      if (generation === this.metadataLoopGeneration) this.cleanupFailedStart();
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
    this.invalidateWatchLoop();
    this.invalidateMetadataLoop();

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

  private invalidateMetadataLoop(): void {
    this.metadataLoopGeneration++;
    if (this.metadataInterval) {
      clearInterval(this.metadataInterval);
      this.metadataInterval = null;
    }
    for (const state of this.streamerStates.values()) {
      invalidateStreamMetadata(state);
    }
  }

  private startMetadataLoop(): void {
    const generation = this.metadataLoopGeneration;
    const refresh = () => {
      if (!this.running || generation !== this.metadataLoopGeneration || this.metadataCheck) return;
      const now = Date.now();
      let next: StreamerState | undefined;
      for (const state of this.streamerStates.values()) {
        if (!isMetadataCheckDue(state, now)) continue;
        if (!next || state.metadata.nextCheckAtMs < next.metadata.nextCheckAtMs) next = state;
      }
      if (!next) return;
      // Admit one metadata check at a time, at most once per second. PubSub
      // only advances due times, so neither startup nor event bursts flood GQL.
      this.metadataCheck = checkStreamerOnline(next).finally(() => {
        this.metadataCheck = null;
      });
    };
    refresh();
    this.metadataInterval = setInterval(refresh, this.METADATA_CHECK_INTERVAL);
  }

  private invalidateWatchLoop(): void {
    this.watchLoopGeneration++;
    if (this.watchLoopTimeout) {
      clearTimeout(this.watchLoopTimeout);
      this.watchLoopTimeout = null;
    }
  }

  private startWatchLoop(): void {
    const generation = ++this.watchLoopGeneration;
    this.scheduleWatchLoop(generation);
  }

  private scheduleWatchLoop(generation: number, delayMs = this.WATCH_LOOP_INTERVAL): void {
    this.watchLoopTimeout = setTimeout(async () => {
      if (generation !== this.watchLoopGeneration) return;
      this.watchLoopTimeout = null;
      if (!this.running) return;

      const nextRunAt = Date.now() + this.WATCH_LOOP_INTERVAL;
      try {
        await this.sendMinuteWatchedForStreamers();
      } catch (err) {
        logger.error({ err }, 'Minute-watched loop error');
      }
      if (this.running && generation === this.watchLoopGeneration) {
        this.scheduleWatchLoop(generation, Math.max(0, nextRunAt - Date.now()));
      }
    }, delayMs);
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
   * core watch loop body, called every ~20 seconds. For each due streamer:
   * touch the newest HLS segment (playlist URL cached per broadcast) to
   * simulate watching, then POST a minute-watched event to the spade endpoint.
   */
  private async sendMinuteWatchedForStreamers(): Promise<void> {
    if (!this.userId) return;

    const now = Date.now();

    const selectedStreamers = selectStreamersToWatch(this.streamerStates, this.MAX_WATCHED_STREAMERS);
    if (selectedStreamers.length === 0) {
      this.persistWatchTransitions([]);
      return;
    }

    const spadeUrl = await twitchClient.getSpadeUrl();
    if (!spadeUrl) {
      this.persistWatchTransitions([]);
      logger.warn('No spade URL available, skipping minute-watched round');
      return;
    }
    this.persistWatchTransitions(selectedStreamers);

    const dueStreamers = selectDueStreamers(selectedStreamers, now, this.MINUTE_WATCHED_INTERVAL);
    if (dueStreamers.length === 0) return;

    const delayBetween = this.WATCH_LOOP_INTERVAL / dueStreamers.length;

    for (let i = 0; i < dueStreamers.length; i++) {
      const streamerState = dueStreamers[i];
      if (!streamerState.channelId || !streamerState.stream.broadcastId) continue;

      try {
        if (!streamerState.stream.hlsPlaylistUrl) {
          const token = await twitchClient.getPlaybackAccessToken(streamerState.name);
          if (!token) {
            logger.debug({ streamer: streamerState.name }, 'Could not get playback token, skipping minute-watched');
            continue;
          }

          streamerState.stream.hlsPlaylistUrl = await twitchClient.fetchLowestQualityPlaylistUrl(
            streamerState.name,
            token.signature,
            token.value
          );
          if (!streamerState.stream.hlsPlaylistUrl) {
            logger.debug({ streamer: streamerState.name }, 'Could not resolve playlist URL, skipping minute-watched');
            continue;
          }
        }

        const watching = await twitchClient.touchStreamSegment(streamerState.name, streamerState.stream.hlsPlaylistUrl);
        if (!watching) {
          streamerState.stream.hlsPlaylistUrl = null;
          logger.debug({ streamer: streamerState.name }, 'Stream segment check failed, will refresh playlist URL');
          continue;
        }

        const payload = encodeMinuteWatchedPayload(
          streamerState.channelId,
          streamerState.stream.broadcastId,
          this.userId,
          streamerState.name
        );

        const success = await twitchClient.sendMinuteWatchedEvent(spadeUrl, payload);
        if (success) {
          const sentAt = Date.now();
          if (streamerState.stream.minuteWatchedTimestamp > 0) {
            streamerState.stream.minuteWatched += (sentAt - streamerState.stream.minuteWatchedTimestamp) / 60_000;
          }
          streamerState.stream.minuteWatchedTimestamp = sentAt;
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
      if (i < dueStreamers.length - 1) {
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

    const watched = this.watchedStreamerNames;

    return configuredStreamers.map((login) => {
      const state = this.streamerStates.get(login);
      return {
        login,
        isOnline: Boolean(state?.isLive),
        isWatched: watched.has(login)
      };
    });
  }

  getWatchedStreams(): WatchedStream[] {
    if (!this.running) return [];

    return getStreamers().flatMap((login) => {
      const state = this.streamerStates.get(login);
      if (!state || !this.watchedStreamerNames.has(login)) return [];
      return [{ login, game: state.stream.game, title: state.stream.title, viewers: state.stream.viewers }];
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
