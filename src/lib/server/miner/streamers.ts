import { twitchClient, type StreamInfo } from '$lib/server/twitch';
import { twitchPubSub } from '$lib/server/pubsub';
import { getStreamers } from '$lib/server/config';
import { getLogger } from '$lib/server/logger';
import { eventStore } from '$lib/server/db/events';
import {
	type StreamerState,
	PubSubTopicType,
	createDefaultStreamData,
	findStreamerByChannelId,
	streamerContext
} from './types';

const logger = getLogger('Miner');

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

		const state = streamerStates.get(name);
		if (state) {
			withEventStore('register_streamer', () => {
				eventStore.registerStreamer({
					login: state.name,
					channelId: state.channelId
				});
			});
		}
	}

	// Remove streamers that are no longer in config
	for (const name of streamerStates.keys()) {
		if (!streamers.includes(name)) {
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
		await twitchPubSub.listen(`${PubSubTopicType.CommunityPointsUser}.${userId}`, true);
		logger.info({ userId }, 'Subscribed to user-level channel points topic');
	} catch (error) {
		logger.error({ err: error }, 'Failed to subscribe to user topic');
		logger.warn('Claim bonuses will be detected via periodic channel points context checks');
	}
}

export async function subscribeToStreamer(state: StreamerState): Promise<void> {
	if (!state.channelId) return;

	try {
		await twitchPubSub.listen(`${PubSubTopicType.VideoPlaybackById}.${state.channelId}`, false);
		logger.info({ streamer: state.name }, 'Subscribed to stream status');
	} catch (error) {
		logger.error({ err: error, streamer: state.name }, 'Failed to subscribe to streamer topic');
	}
}

export async function checkStreamerOnline(state: StreamerState): Promise<void> {
	if (!state.channelId) return;

	if (state.offlineAt > 0 && Date.now() - state.offlineAt < 60_000) {
		logger.debug({ streamer: state.name }, 'Skipping online check (offline debounce)');
		return;
	}

	const streamInfo = await twitchClient.getStreamInfo(state.name);

	if (streamInfo) {
		applyStreamInfo(state, streamInfo);
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
			logger.warn({ ...logContext, reason: result.reason }, 'Failed to claim bonus');
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
		logger.info(logContext, 'Successfully claimed bonus');
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

export async function processStreamer(
	streamerStates: Map<string, StreamerState>,
	state: StreamerState
): Promise<void> {
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
		withEventStore('context_snapshot', () => {
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

	return eligible.slice(0, maxWatched);
}
