import {
	type StreamerState,
	type ClaimAvailableData,
	type PointsEarnedData,
	CommunityPointsMessageType,
	VideoPlaybackMessageType,
	PubSubTopicType,
	createDefaultStreamData,
	findStreamerByChannelId,
	streamerContext
} from './types';
import { getLogger } from '$lib/server/logger';
import { eventStore } from '$lib/server/db/events';

const logger = getLogger('Miner');

function withEventStore(operation: string, action: () => void): void {
	try {
		action();
	} catch (error) {
		logger.error({ err: error, operation }, 'Failed to persist miner event');
	}
}

export interface MessageDedup {
	lastMessageTimestamp: number;
	lastMessageIdentifier: string;
}

export interface EventHandlerDeps {
	streamerStates: Map<string, StreamerState>;
	dedup: MessageDedup;
	claimBonus: (channelId: string, claimId: string, source: 'pubsub' | 'gql_context') => Promise<void>;
	checkStreamerOnline: (state: StreamerState) => Promise<void>;
}

export function handlePubSubMessage(
	deps: EventHandlerDeps,
	topic: string,
	messageType: string,
	data: unknown
): void {
	const now = Date.now();
	const identifier = `${messageType}.${topic}`;
	if (identifier === deps.dedup.lastMessageIdentifier && now - deps.dedup.lastMessageTimestamp < 500) {
		logger.debug({ topic, messageType }, 'Skipping duplicate PubSub message');
		return;
	}
	deps.dedup.lastMessageTimestamp = now;
	deps.dedup.lastMessageIdentifier = identifier;

	const topicParts = topic.split('.');
	const topicType = topicParts[0];
	const topicId = topicParts[1];

	if (topicType === PubSubTopicType.CommunityPointsUser) {
		handleCommunityPointsMessage(deps, messageType, data).catch((err) => {
			logger.error({ err, topic, messageType }, 'Error handling community points message');
		});
	} else if (topicType === PubSubTopicType.VideoPlaybackById) {
		handleVideoPlaybackMessage(deps, topicId, messageType, data);
	}
}

async function handleCommunityPointsMessage(
	deps: EventHandlerDeps,
	messageType: string,
	data: unknown
): Promise<void> {
	const { streamerStates } = deps;

	if (messageType === CommunityPointsMessageType.ClaimAvailable) {
		const claimData = data as { data: ClaimAvailableData };
		const { channel_id: channelId, id: claimId } = claimData.data.claim;
		const streamer = findStreamerByChannelId(streamerStates, channelId);
		const logContext = streamerContext(streamer, channelId);

		logger.info(logContext, 'Claim available');
		withEventStore('claim_available', () => {
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
		await deps.claimBonus(channelId, claimId, 'pubsub');
	} else if (messageType === CommunityPointsMessageType.PointsEarned) {
		const pointsData = data as { data: PointsEarnedData };
		const { balance, point_gain } = pointsData.data;
		const channelId = pointsData.data.channel_id ?? balance.channel_id;
		const streamer = channelId ? findStreamerByChannelId(streamerStates, channelId) : undefined;

		logger.info(
			{
				...streamerContext(streamer, channelId),
				points: point_gain.total_points,
				reason: point_gain.reason_code,
				balance: balance.balance
			},
			'Points earned'
		);

		if (channelId) {
			withEventStore('points_earned', () => {
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

function handleVideoPlaybackMessage(
	deps: EventHandlerDeps,
	channelId: string,
	messageType: string,
	data: unknown
): void {
	const streamer = findStreamerByChannelId(deps.streamerStates, channelId);
	if (!streamer) return;

	if (messageType === VideoPlaybackMessageType.StreamUp) {
		// record timestamp but do NOT mark live yet -- wait for viewcount verification
		streamer.stream.streamUpAt = Date.now();
		logger.debug({ streamer: streamer.name }, 'stream-up received, waiting for verification');
	} else if (messageType === VideoPlaybackMessageType.StreamDown) {
		const wasLive = streamer.isLive;
		const {
			title: previousTitle,
			game: previousGame,
			viewers: previousViewers,
			broadcastId: previousBroadcastId
		} = streamer.stream;

		if (streamer.isLive) {
			logger.info({ streamer: streamer.name }, 'Streamer went OFFLINE');
		}

		if (wasLive) {
			withEventStore('stream_down_pubsub', () => {
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
			deps.checkStreamerOnline(streamer).catch((err) => {
				logger.error({ err, streamer: streamer.name }, 'Failed to check streamer online');
			});
		}
	}
}
