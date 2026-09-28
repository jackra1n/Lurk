import { twitchPubSubPool } from '$lib/server/pubsub';
import { twitchClient, type StreamInfo } from '$lib/server/twitch-client';
import { getStreamers } from '$lib/server/config';
import { getLogger } from '$lib/server/logger';
import { eventStore } from '$lib/server/db/events';
import { getStreamerChannelPointsState, setStreamerChannelPointsState } from '$lib/server/db/streamers';
import {
  type StreamerState,
  PubSubTopicType,
  createDefaultStreamData,
  createDefaultStreamMetadataState,
  findStreamerByChannelId,
  streamerContext
} from './types';
import {
  CHANNEL_POINTS_STATUS,
  DEFAULT_CHANNEL_POINTS_STATUS,
  DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS
} from './channel-points-status';

const logger = getLogger('Miner');
const DISABLED_CHANNEL_POINTS_RECHECK_INTERVAL_MS = 12 * 60 * 60_000;
const LIVE_METADATA_REFRESH_INTERVAL_MS = 10 * 60_000;
const OFFLINE_METADATA_REFRESH_INTERVAL_MS = 15 * 60_000;
const METADATA_RETRY_INTERVAL_MS = 60_000;
const metadataChecks = new WeakMap<StreamerState, Promise<void>>();

export function invalidateStreamMetadata(state: StreamerState, nextCheckAtMs = 0): void {
  state.metadata.generation++;
  state.metadata.status = state.metadata.lastSuccessAtMs > 0 ? 'stale' : 'unavailable';
  state.metadata.nextCheckAtMs = nextCheckAtMs;
}

function setChannelPointsStatus(
  state: StreamerState,
  nextStatus: StreamerState['channelPointsStatus'],
  checkedAtMs: number
): void {
  const previousStatus = state.channelPointsStatus;
  const changed = previousStatus !== nextStatus;

  state.channelPointsStatus = nextStatus;
  state.channelPointsStatusCheckedAtMs = checkedAtMs;

  setStreamerChannelPointsState(
    {
      login: state.name,
      channelId: state.channelId
    },
    {
      status: nextStatus,
      checkedAtMs
    }
  );

  if (!changed) return;

  if (nextStatus === CHANNEL_POINTS_STATUS.Disabled) {
    logger.warn(
      {
        ...streamerContext(state),
        checkedAtMs
      },
      'Channel points are disabled or unavailable for streamer'
    );
    return;
  }

  if (previousStatus === CHANNEL_POINTS_STATUS.Disabled && nextStatus === CHANNEL_POINTS_STATUS.Enabled) {
    logger.info({ ...streamerContext(state), checkedAtMs }, 'Channel points were re-enabled for streamer');
  }
}

function shouldSkipContextRefreshForDisabledStatus(state: StreamerState): boolean {
  return (
    state.channelPointsStatus === CHANNEL_POINTS_STATUS.Disabled &&
    state.channelPointsStatusCheckedAtMs > 0 &&
    Date.now() - state.channelPointsStatusCheckedAtMs < DISABLED_CHANNEL_POINTS_RECHECK_INTERVAL_MS
  );
}

export function withEventStore(operation: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    logger.error({ err: error, operation }, 'Failed to persist miner event');
  }
}

export async function syncStreamers(streamerStates: Map<string, StreamerState>): Promise<void> {
  const streamers = getStreamers();

  // Add new streamers
  for (const name of streamers) {
    if (!streamerStates.has(name)) {
      // Get channel ID via GraphQL
      const channelId = await twitchClient.getUserId(name);

      streamerStates.set(name, {
        name,
        channelId,
        isLive: false,
        channelPoints: 0,
        channelPointsStatus: DEFAULT_CHANNEL_POINTS_STATUS,
        channelPointsStatusCheckedAtMs: DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS,
        startingPoints: null,
        offlineAt: 0,
        lastContextRefresh: 0,
        metadata: createDefaultStreamMetadataState(),
        activeMultipliers: [],
        history: {},
        stream: createDefaultStreamData()
      });

      if (!channelId) {
        logger.debug({ streamer: name }, 'Channel ID lookup unavailable; retrying on next context refresh');
      }
    } else {
      const state = streamerStates.get(name)!;
      if (!state.channelId) {
        state.channelId = await twitchClient.getUserId(name);
        if (state.channelId) {
          await subscribeToStreamer(state);
          logger.info({ ...streamerContext(state) }, 'Channel ID lookup recovered');
        }
      }
    }

    const state = streamerStates.get(name);
    if (state) {
      withEventStore('register_streamer', () => {
        eventStore.registerStreamer({
          login: state.name,
          channelId: state.channelId
        });
      });

      const persistedState = getStreamerChannelPointsState({
        login: state.name,
        channelId: state.channelId
      });
      state.channelPointsStatus = persistedState.status;
      state.channelPointsStatusCheckedAtMs = persistedState.checkedAtMs;
    }
  }

  // Remove streamers that are no longer in config
  for (const name of streamerStates.keys()) {
    if (!streamers.includes(name)) {
      invalidateStreamMetadata(streamerStates.get(name)!);
      streamerStates.delete(name);
    }
  }
}

export async function subscribeToPointsTopic(userId: string | null): Promise<void> {
  if (!userId) {
    logger.warn('No user ID available - skipping user-level PubSub topic');
    logger.info('Claim bonuses will be detected via periodic channel points context checks');
    return;
  }

  try {
    await twitchPubSubPool.listen(`${PubSubTopicType.CommunityPointsUser}.${userId}`, true);
    logger.info({ userId }, 'Subscribed to user-level channel points topic');
  } catch (error) {
    logger.error({ err: error }, 'Failed to subscribe to user topic');
    logger.warn('Claim bonuses will be detected via periodic channel points context checks');
  }
}

export async function subscribeToStreamer(state: StreamerState): Promise<void> {
  if (!state.channelId) return;

  try {
    await twitchPubSubPool.listen(`${PubSubTopicType.VideoPlaybackById}.${state.channelId}`, false);
    logger.info({ streamer: state.name }, 'Subscribed to stream status');
  } catch (error) {
    logger.error({ err: error, streamer: state.name }, 'Failed to subscribe to streamer topic');
  }
}

export function isMetadataCheckDue(state: StreamerState, now: number): boolean {
  return (
    Boolean(state.channelId) &&
    now >= state.metadata.nextCheckAtMs &&
    (state.offlineAt <= 0 || now - state.offlineAt >= 60_000)
  );
}

export function checkStreamerOnline(state: StreamerState): Promise<void> {
  const inFlight = metadataChecks.get(state);
  if (inFlight) return inFlight;
  const now = Date.now();
  if (!isMetadataCheckDue(state, now)) return Promise.resolve();

  const generation = state.metadata.generation;
  state.metadata.lastAttemptAtMs = now;
  state.metadata.status = state.metadata.lastSuccessAtMs > 0 ? 'stale' : 'unavailable';
  // Defer execution until the shared promise is registered, including synchronous failures.
  const check = Promise.resolve()
    .then(() => refreshStreamMetadata(state, generation))
    .catch((err) => {
      if (generation !== state.metadata.generation) return;
      state.metadata.status = 'failed';
      state.metadata.lastFailureAtMs = Date.now();
      state.metadata.nextCheckAtMs = Date.now() + METADATA_RETRY_INTERVAL_MS;
      logger.error({ err, streamer: state.name }, 'Failed to refresh stream metadata');
    })
    .finally(() => {
      metadataChecks.delete(state);
    });
  metadataChecks.set(state, check);
  return check;
}

async function refreshStreamMetadata(state: StreamerState, generation: number): Promise<void> {
  if (generation !== state.metadata.generation) return;
  const streamStatus = await twitchClient.getStreamInfoStatus(state.name);
  if (generation !== state.metadata.generation) return;

  const now = Date.now();
  if (streamStatus.kind === 'unknown') {
    state.metadata.status = 'failed';
    state.metadata.lastFailureAtMs = now;
    state.metadata.nextCheckAtMs = Math.max(now + METADATA_RETRY_INTERVAL_MS, streamStatus.retryAtMs ?? 0);
    if (streamStatus.reason !== 'gql_error') {
      logger.warn(
        {
          streamer: state.name,
          reason: streamStatus.reason,
          errors: streamStatus.errors?.map((error) => error.message)
        },
        'Could not verify streamer status via API; preserving previous state'
      );
    }
    return;
  }

  state.metadata.status = 'fresh';
  state.metadata.lastSuccessAtMs = now;
  state.metadata.nextCheckAtMs =
    now + (streamStatus.kind === 'live' ? LIVE_METADATA_REFRESH_INTERVAL_MS : OFFLINE_METADATA_REFRESH_INTERVAL_MS);

  if (streamStatus.kind === 'live') {
    applyStreamInfo(state, streamStatus.info);
    const wasOffline = !state.isLive;
    if (wasOffline) {
      state.isLive = true;
      state.stream.onlineAt = Date.now();
      state.stream.watchStreakMissing = true;
      state.stream.minuteWatched = 0;
      state.stream.minuteWatchedTimestamp = 0;
      withEventStore('stream_up_gql', () => {
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
        {
          streamer: state.name,
          title: state.stream.title,
          game: state.stream.game,
          viewers: state.stream.viewers
        },
        'Streamer went LIVE'
      );
    }
  } else if (streamStatus.kind === 'offline') {
    if (state.isLive) {
      const {
        title: previousTitle,
        game: previousGame,
        viewers: previousViewers,
        broadcastId: previousBroadcastId
      } = state.stream;
      state.isLive = false;
      state.offlineAt = Date.now();
      withEventStore('stream_down_gql', () => {
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

export function applyStreamInfo(state: StreamerState, info: StreamInfo): void {
  state.stream.broadcastId = info.broadcastId;
  state.stream.title = info.title;
  state.stream.game = info.game?.displayName ?? null;
  state.stream.viewers = info.viewersCount;
}

export async function claimBonus(
  streamerStates: Map<string, StreamerState>,
  channelId: string,
  claimId: string,
  source: 'pubsub' | 'gql_context'
): Promise<void> {
  const streamer = findStreamerByChannelId(streamerStates, channelId);
  const logContext = { ...streamerContext(streamer, channelId), claimId, source };
  withEventStore('claim_attempt', () => {
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
    logger.info(logContext, 'Claiming bonus');
    const result = await twitchClient.claimBonus(channelId, claimId);
    if (!result.ok) {
      withEventStore('claim_failed', () => {
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
      if (result.reason !== 'gql_error') {
        logger.warn({ ...logContext, reason: result.reason }, 'Failed to claim bonus');
      }
      return;
    }

    withEventStore('claim_success', () => {
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
  } catch (error) {
    withEventStore('claim_failed', () => {
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

export async function processStreamer(streamerStates: Map<string, StreamerState>, state: StreamerState): Promise<void> {
  state.lastContextRefresh = Date.now();

  if (!state.channelId) {
    logger.debug({ streamer: state.name }, 'Skipping streamer without channel ID');
    return;
  }

  if (shouldSkipContextRefreshForDisabledStatus(state)) {
    logger.debug({ streamer: state.name }, 'Skipping context refresh for disabled channel points (backoff)');
    return;
  }

  // only refresh channel points context -- PubSub handles live status
  const context = await twitchClient.getChannelPointsContext(state.name);
  if (context) {
    const checkedAtMs = Date.now();
    if (context.channelPointsEnabled === false) {
      setChannelPointsStatus(state, CHANNEL_POINTS_STATUS.Disabled, checkedAtMs);
      return;
    }
    if (context.channelPointsEnabled === true) {
      setChannelPointsStatus(state, CHANNEL_POINTS_STATUS.Enabled, checkedAtMs);
    } else {
      setChannelPointsStatus(state, CHANNEL_POINTS_STATUS.Unknown, checkedAtMs);
    }

    if (state.startingPoints === null) {
      state.startingPoints = context.balance;
    }
    state.channelPoints = context.balance;
    state.activeMultipliers = context.activeMultipliers;

    if (context.availableClaimId && state.channelId) {
      logger.info({ streamer: state.name }, 'Found available claim via context check');
      withEventStore('claim_available_context', () => {
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
      await claimBonus(streamerStates, state.channelId, context.availableClaimId, 'gql_context');
    }
  } else {
    logger.debug({ streamer: state.name }, 'Channel points context refresh unavailable; preserving previous state');
  }
}

export function selectStreamersToWatch(
  streamerStates: Map<string, StreamerState>,
  maxWatched: number
): StreamerState[] {
  const now = Date.now();
  const eligible: StreamerState[] = [];

  for (const [, state] of streamerStates) {
    if (
      state.channelPointsStatus !== CHANNEL_POINTS_STATUS.Disabled &&
      state.isLive &&
      state.channelId &&
      state.stream.broadcastId &&
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

  return eligible.slice(0, maxWatched);
}

// real players emit minute-watched roughly once per minute per stream
export function selectDueStreamers(
  selected: StreamerState[],
  now: number,
  minuteWatchedIntervalMs: number
): StreamerState[] {
  return selected.filter((state) => now - state.stream.minuteWatchedTimestamp >= minuteWatchedIntervalMs);
}
