import { randomBytes } from 'node:crypto';
import {
	GQL_URL,
	CLIENT_ID,
	CLIENT_VERSION_FALLBACK,
	GQL_OPERATIONS,
	USER_AGENT
} from '../constants';
import { getLogger } from '../logger';
import { AsyncRateLimiter, RateLimiterQueueFullError } from './rate-limiter';

const VERSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const TWITCH_BUILD_ID_PATTERN = /window\.__twilightBuildID\s*=\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;
const GQL_RATE_LIMIT_RPS = 5;
const GQL_RATE_LIMIT_BURST = GQL_RATE_LIMIT_RPS;
const GQL_RATE_LIMIT_MAX_QUEUE = 300;

const logger = getLogger('TwitchClient');

export interface TwitchUser {
	id: string;
	login: string;
	displayName: string;
}

export interface StreamInfo {
	broadcastId: string;
	title: string;
	game: { displayName: string } | null;
	tags: { localizedName: string }[];
	viewersCount: number;
}

export interface ChannelPointsContext {
	balance: number;
	availableClaimId: string | null;
	activeMultipliers: { factor: number }[];
}

export type ClaimBonusResult =
	| { ok: true }
	| {
			ok: false;
			reason: 'not_authenticated' | 'gql_error';
			errors?: Array<{ message: string }>;
	  };

interface GqlResponse<T = unknown> {
	data?: T;
	errors?: GqlError[];
}

interface GqlError {
	message: string;
	path?: Array<string | number>;
}

type GqlErrorCategory = 'transient' | 'stale_query' | 'auth' | 'fatal';

interface GqlErrorSummary {
	category: GqlErrorCategory;
	retryable: boolean;
	persistedQueryNotFound: boolean;
	messages: string[];
}

export type StreamInfoStatus =
	| { kind: 'live'; info: StreamInfo }
	| { kind: 'offline' }
	| {
			kind: 'unknown';
			reason: 'gql_error' | 'not_authenticated';
			errors?: GqlError[];
	  };

const RETRYABLE_GQL_MESSAGES = new Set([
	'service timeout',
	'service unavailable',
	'context deadline exceeded',
	'service error',
	'server error'
]);

const AUTH_GQL_MESSAGE_PATTERNS = ['not authorized', 'unauthorized', 'authentication', 'invalid oauth', 'forbidden'];
const PERSISTED_QUERY_NOT_FOUND = 'persistedquerynotfound';
const MAX_GQL_ATTEMPTS = 4;
const GQL_RETRY_BASE_DELAY_MS = 800;
const GQL_RETRY_MAX_DELAY_MS = 10_000;

const normalizeErrorMessage = (message: string) => message.trim().toLowerCase();

const jitterDelay = (delayMs: number) => {
	const jitter = (Math.random() * 0.4) - 0.2;
	return Math.max(200, Math.round(delayMs * (1 + jitter)));
};

const summarizeGqlErrors = (errors: GqlError[]) =>
	[...new Set(errors.map((error) => error.message))].slice(0, 4);

function classifyGqlErrors(errors: GqlError[]): GqlErrorSummary {
	const messages = summarizeGqlErrors(errors);
	const normalized = messages.map(normalizeErrorMessage);
	const persistedQueryNotFound = normalized.some((message) => message.includes(PERSISTED_QUERY_NOT_FOUND));
	const transient = normalized.some((message) => RETRYABLE_GQL_MESSAGES.has(message));
	const auth = normalized.some((message) =>
		AUTH_GQL_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))
	);

	if (persistedQueryNotFound) {
		return {
			category: 'stale_query',
			retryable: true,
			persistedQueryNotFound: true,
			messages
		};
	}

	if (transient) {
		return {
			category: 'transient',
			retryable: true,
			persistedQueryNotFound: false,
			messages
		};
	}

	if (auth) {
		return {
			category: 'auth',
			retryable: false,
			persistedQueryNotFound: false,
			messages
		};
	}

	return {
		category: 'fatal',
		retryable: false,
		persistedQueryNotFound: false,
		messages
	};
}

export class TwitchClient {
	private authToken: string | null = null;
	private deviceId = '';
	private clientSessionId = randomBytes(16).toString('hex');
	private clientVersion = CLIENT_VERSION_FALLBACK;
	private lastVersionFetch = 0;
	private gqlLimiter = new AsyncRateLimiter({
		ratePerSecond: GQL_RATE_LIMIT_RPS,
		burst: GQL_RATE_LIMIT_BURST,
		maxQueue: GQL_RATE_LIMIT_MAX_QUEUE
	});

	private retryDelayMs(attempt: number): number {
		const exponential = GQL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
		return jitterDelay(Math.min(GQL_RETRY_MAX_DELAY_MS, exponential));
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	setAuthToken(token: string): void {
		this.authToken = token;
	}

	setDeviceId(id: string): void {
		this.deviceId = id;
	}

	getAuthToken(): string | null {
		return this.authToken;
	}

	isAuthenticated(): boolean {
		return this.authToken !== null && this.authToken.length > 0;
	}

	// fetch the current Twitch client version (twilightBuildID) from twitch.tv
	private async fetchClientVersion(force = false): Promise<string> {
		const now = Date.now();
		if (!force && now - this.lastVersionFetch < VERSION_REFRESH_INTERVAL_MS) {
			return this.clientVersion;
		}

		try {
			const response = await fetch('https://www.twitch.tv', {
				headers: { 'User-Agent': USER_AGENT }
			});

			if (!response.ok) {
				logger.debug({ status: response.status }, 'Failed to fetch twitch.tv for client version');
				return this.clientVersion;
			}

			const html = await response.text();
			const match = html.match(TWITCH_BUILD_ID_PATTERN);
			if (!match) {
				logger.debug('Could not find twilightBuildID in twitch.tv HTML');
				return this.clientVersion;
			}

			this.clientVersion = match[1];
			this.lastVersionFetch = now;
			logger.debug({ clientVersion: this.clientVersion }, 'Updated client version');
			return this.clientVersion;
		} catch (error) {
			logger.debug({ err: error }, 'Error fetching client version');
			return this.clientVersion;
		}
	}

	private async postGqlRequest<T = unknown>(
		operation: (typeof GQL_OPERATIONS)[keyof typeof GQL_OPERATIONS],
		variables?: Record<string, unknown>
	): Promise<GqlResponse<T>> {
		if (!this.authToken) {
			throw new Error('Not authenticated');
		}
		const authToken = this.authToken;

		const body = {
			...operation,
			variables: variables || {}
		};

		let refreshedForPersistedQuery = false;

		for (let attempt = 1; attempt <= MAX_GQL_ATTEMPTS; attempt += 1) {
			try {
				const clientVersion = await this.fetchClientVersion();

				const { value: response, waitMs, queueDepthAtEnqueue } = await this.gqlLimiter.schedule(
					operation.operationName,
					() =>
						fetch(GQL_URL, {
							method: 'POST',
							headers: {
								Authorization: `OAuth ${authToken}`,
								'Client-Id': CLIENT_ID,
								'Client-Version': clientVersion,
								'Client-Session-Id': this.clientSessionId,
								'User-Agent': USER_AGENT,
								'X-Device-Id': this.deviceId,
								'Content-Type': 'application/json'
							},
							body: JSON.stringify(body)
						})
				);

				logger.debug(
					{
						operation: operation.operationName,
						attempt,
						waitMs,
						queueDepth: queueDepthAtEnqueue,
						ratePerSecond: this.gqlLimiter.getRatePerSecond(),
						burst: this.gqlLimiter.getBurst()
					},
					'GQL request sent via rate limiter'
				);
				if (waitMs > 1_500 || queueDepthAtEnqueue >= Math.floor(this.gqlLimiter.getMaxQueue() * 0.8)) {
					logger.warn(
						{
							operation: operation.operationName,
							waitMs,
							queueDepth: queueDepthAtEnqueue,
							maxQueue: this.gqlLimiter.getMaxQueue()
						},
						'GQL rate limiter queue is under pressure'
					);
				}

				if (!response.ok) {
					const message = `HTTP ${response.status}`;
					const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
					if (retryable && attempt < MAX_GQL_ATTEMPTS) {
						const delayMs = this.retryDelayMs(attempt);
						logger.debug(
							{
								operation: operation.operationName,
								status: response.status,
								attempt,
								nextRetryInMs: delayMs
							},
							'Transient GQL HTTP failure, retrying'
						);
						await this.sleep(delayMs);
						continue;
					}

					logger.warn(
						{
							operation: operation.operationName,
							status: response.status,
							statusText: response.statusText,
							attempt
						},
						'GQL request failed'
					);
					return { errors: [{ message }] };
				}

				const result: GqlResponse<T> = await response.json();
				const errors = result.errors ?? [];
				if (errors.length === 0) {
					return result;
				}

				const summary = classifyGqlErrors(errors);
				if (summary.persistedQueryNotFound && !refreshedForPersistedQuery) {
					refreshedForPersistedQuery = true;
					logger.warn(
						{
							operation: operation.operationName,
							attempt
						},
						'PersistedQueryNotFound encountered, refreshing client version'
					);
					await this.fetchClientVersion(true);
				}

				if (summary.retryable && attempt < MAX_GQL_ATTEMPTS) {
					const delayMs = this.retryDelayMs(attempt);
					logger.debug(
						{
							operation: operation.operationName,
							attempt,
							nextRetryInMs: delayMs,
							errors: summary.messages
						},
						'Transient GQL error, retrying'
					);
					await this.sleep(delayMs);
					continue;
				}

				const context = {
					operation: operation.operationName,
					attempt,
					errors: summary.messages
				};
				if (summary.category === 'fatal') {
					logger.error(context, 'GQL request failed with non-retryable errors');
				} else {
					logger.warn(context, 'GQL request failed after retries');
				}
				return result;
			} catch (error) {
				if (error instanceof RateLimiterQueueFullError) {
					logger.warn(
						{
							operation: operation.operationName,
							queueDepth: this.gqlLimiter.getQueueDepth(),
							maxQueue: error.maxQueue
						},
						'GQL request dropped because rate limiter queue is full'
					);
					return { errors: [{ message: 'RateLimiterQueueFull' }] };
				}

				if (attempt < MAX_GQL_ATTEMPTS) {
					const delayMs = this.retryDelayMs(attempt);
					logger.debug(
						{
							operation: operation.operationName,
							attempt,
							nextRetryInMs: delayMs,
							error: String(error)
						},
						'GQL request errored, retrying'
					);
					await this.sleep(delayMs);
					continue;
				}

				logger.error({ operation: operation.operationName, err: error }, 'GQL request error');
				return { errors: [{ message: String(error) }] };
			}
		}

		return { errors: [{ message: 'GqlRetryExhausted' }] };
	}

	async getUserId(login: string): Promise<string | null> {
		if (!this.isAuthenticated()) {
			logger.warn('Cannot get user ID - not authenticated');
			return null;
		}

		const response = await this.postGqlRequest<{ user: { id: string } | null }>(
			GQL_OPERATIONS.GetIDFromLogin,
			{ login: login.toLowerCase() }
		);

		if (response.errors) {
			logger.error({ login, errors: summarizeGqlErrors(response.errors) }, 'Failed to get user ID');
			return null;
		}

		const userId = response.data?.user?.id;
		if (!userId) {
			logger.info({ login }, 'User not found');
			return null;
		}

		logger.debug({ login, userId }, 'Got user ID');
		return userId;
	}

	async getUser(login: string): Promise<TwitchUser | null> {
		const userId = await this.getUserId(login);
		if (!userId) {
			return null;
		}

		return {
			id: userId,
			login: login.toLowerCase(),
			displayName: login
		};
	}

	async getChannelPointsContext(channelLogin: string): Promise<ChannelPointsContext | null> {
		if (!this.isAuthenticated()) {
			return null;
		}

		interface ChannelPointsResponse {
			community: {
				channel: {
					self: {
						communityPoints: {
							balance: number;
							availableClaim: { id: string } | null;
							activeMultipliers: { factor: number }[];
						};
					};
				};
			} | null;
		}

		const response = await this.postGqlRequest<ChannelPointsResponse>(
			GQL_OPERATIONS.ChannelPointsContext,
			{ channelLogin: channelLogin.toLowerCase() }
		);

		if (response.errors) {
			logger.error(
				{ channelLogin, errors: summarizeGqlErrors(response.errors) },
				'Failed to get channel points context'
			);
			return null;
		}

		if (!response.data?.community?.channel) {
			logger.debug({ channelLogin }, 'Channel points context missing channel data');
			return null;
		}

		const points = response.data.community.channel.self.communityPoints;
		return {
			balance: points.balance,
			availableClaimId: points.availableClaim?.id || null,
			activeMultipliers: points.activeMultipliers || []
		};
	}

	async getStreamInfoStatus(channelLogin: string): Promise<StreamInfoStatus> {
		if (!this.isAuthenticated()) {
			return { kind: 'unknown', reason: 'not_authenticated' };
		}

		interface StreamInfoResponse {
			user: {
				stream: {
					id: string;
					title: string;
					game: { displayName: string } | null;
					freeformTags: { name: string }[];
					viewersCount: number;
				} | null;
			} | null;
		}

		const response = await this.postGqlRequest<StreamInfoResponse>(
			GQL_OPERATIONS.VideoPlayerStreamInfoOverlayChannel,
			{ channel: channelLogin.toLowerCase() }
		);

		if (response.errors) {
			logger.error(
				{ channelLogin, errors: summarizeGqlErrors(response.errors) },
				'Failed to get stream info'
			);
			return { kind: 'unknown', reason: 'gql_error', errors: response.errors };
		}

		const stream = response.data?.user?.stream;
		if (!stream) {
			return { kind: 'offline' };
		}

		return {
			kind: 'live',
			info: {
				broadcastId: stream.id,
				title: stream.title,
				game: stream.game,
				tags: (stream.freeformTags || []).map((t) => ({ localizedName: t.name })),
				viewersCount: stream.viewersCount
			}
		};
	}

	async getStreamInfo(channelLogin: string): Promise<StreamInfo | null> {
		const status = await this.getStreamInfoStatus(channelLogin);
		return status.kind === 'live' ? status.info : null;
	}

	async claimBonus(channelId: string, claimId: string): Promise<ClaimBonusResult> {
		if (!this.isAuthenticated()) {
			logger.debug({ channelId, claimId }, 'Cannot claim bonus - not authenticated');
			return { ok: false, reason: 'not_authenticated' };
		}

		logger.debug({ channelId, claimId }, 'Claiming bonus');

		const response = await this.postGqlRequest(GQL_OPERATIONS.ClaimCommunityPoints, {
			input: {
				channelID: channelId,
				claimID: claimId
			}
		});

		if (response.errors) {
			logger.debug({ channelId, claimId, errors: response.errors }, 'Claim bonus request failed');
			return { ok: false, reason: 'gql_error', errors: response.errors };
		}

		return { ok: true };
	}

	async getSpadeUrl(channelLogin: string): Promise<string | null> {
		try {
			const headers = { 'User-Agent': USER_AGENT };

			const pageResponse = await fetch(`https://www.twitch.tv/${channelLogin.toLowerCase()}`, {
				headers,
				redirect: 'follow'
			});
			if (!pageResponse.ok) {
				logger.error({ channelLogin, status: pageResponse.status }, 'Failed to fetch channel page for spade URL');
				return null;
			}
			const pageHtml = await pageResponse.text();

			const settingsMatch = pageHtml.match(
				/(https:\/\/static\.twitchcdn\.net\/config\/settings.*?js|https:\/\/assets\.twitch\.tv\/config\/settings.*?\.js)/
			);
			if (!settingsMatch) {
				logger.error({ channelLogin }, 'Could not find settings JS URL in channel page');
				return null;
			}

			const settingsResponse = await fetch(settingsMatch[1], { headers });
			if (!settingsResponse.ok) {
				logger.error({ channelLogin, status: settingsResponse.status }, 'Failed to fetch settings JS');
				return null;
			}
			const settingsJs = await settingsResponse.text();

			const spadeMatch = settingsJs.match(/"spade_url":"(.*?)"/);
			if (!spadeMatch) {
				logger.error({ channelLogin }, 'Could not find spade_url in settings JS');
				return null;
			}

			logger.debug({ channelLogin, spadeUrl: spadeMatch[1] }, 'Got spade URL');
			return spadeMatch[1];
		} catch (error) {
			logger.error({ err: error, channelLogin }, 'Error fetching spade URL');
			return null;
		}
	}


	// get a playback access token for a live channel (needed for HLS manifest)
	async getPlaybackAccessToken(streamerName: string): Promise<{ signature: string; value: string } | null> {
		if (!this.isAuthenticated()) return null;

		interface PlaybackTokenResponse {
			streamPlaybackAccessToken: {
				signature: string;
				value: string;
			} | null;
		}

		const response = await this.postGqlRequest<PlaybackTokenResponse>(
			GQL_OPERATIONS.PlaybackAccessToken,
			{
				login: streamerName.toLowerCase(),
				isLive: true,
				isVod: false,
				vodID: '',
				playerType: 'site'
			}
		);

		if (response.errors) {
			logger.error(
				{ login: streamerName, errors: summarizeGqlErrors(response.errors) },
				'Failed to get playback access token'
			);
			return null;
		}

		const token = response.data?.streamPlaybackAccessToken;
		if (!token?.signature || !token?.value) {
			logger.debug({ login: streamerName }, 'No playback access token returned (stream may be offline)');
			return null;
		}

		return { signature: token.signature, value: token.value };
	}

	// fetch the HLS master manifest for a channel, then resolve the lowest quality stream URL
	async fetchLowestQualityStreamUrl(
		login: string,
		signature: string,
		value: string
	): Promise<string | null> {
		try {
			const headers = { 'User-Agent': USER_AGENT };
			const masterUrl =
				`https://usher.ttvnw.net/api/channel/hls/${login.toLowerCase()}.m3u8` +
				`?sig=${signature}&token=${encodeURIComponent(value)}`;

			const masterResponse = await fetch(masterUrl, { headers, redirect: 'follow' });
			if (!masterResponse.ok) {
				logger.debug({ login, status: masterResponse.status }, 'Failed to fetch HLS master manifest');
				return null;
			}
			const masterPlaylist = await masterResponse.text();

			// last non-empty line in the master playlist is the lowest quality variant URL
			const masterLines = masterPlaylist.split('\n').filter((l) => l.trim().length > 0);
			const lowestQualityUrl = masterLines[masterLines.length - 1];
			if (!lowestQualityUrl || lowestQualityUrl.startsWith('#')) {
				logger.debug({ login }, 'No stream URL found in master manifest');
				return null;
			}

			// fetch the variant playlist to get an actual stream segment URL
			const variantResponse = await fetch(lowestQualityUrl, { headers, redirect: 'follow' });
			if (!variantResponse.ok) {
				logger.debug({ login, status: variantResponse.status }, 'Failed to fetch variant playlist');
				return null;
			}
			const variantPlaylist = await variantResponse.text();

			// second-to-last non-empty line is the segment URL
			const variantLines = variantPlaylist.split('\n').filter((l) => l.trim().length > 0);
			const streamSegmentUrl = variantLines[variantLines.length - 1];
			if (!streamSegmentUrl || streamSegmentUrl.startsWith('#')) {
				logger.debug({ login }, 'No stream segment URL found in variant playlist');
				return null;
			}

			// verify segment URL is reachable
			const headResponse = await fetch(streamSegmentUrl, { method: 'HEAD', headers, redirect: 'follow' });
			if (!headResponse.ok) {
				logger.debug({ login, status: headResponse.status }, 'Stream segment URL HEAD check failed');
				return null;
			}

			return streamSegmentUrl;
		} catch (error) {
			logger.error({ err: error, login }, 'Error fetching lowest quality stream URL');
			return null;
		}
	}

	async sendMinuteWatchedEvent(spadeUrl: string, encodedPayload: string): Promise<boolean> {
		try {
			const response = await fetch(spadeUrl, {
				method: 'POST',
				headers: {
					'User-Agent': USER_AGENT,
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams({ data: encodedPayload })
			});

			return response.status === 204;
		} catch (error) {
			logger.error({ err: error }, 'Error sending minute-watched event');
			return false;
		}
	}
}

// encode a minute-watched payload as a base64 JSON string ready for the spade endpoint
export function encodeMinuteWatchedPayload(
	channelId: string,
	broadcastId: string,
	userId: string,
	login: string
): string {
	const payload = [
		{
			event: 'minute-watched',
			properties: {
				channel_id: channelId,
				broadcast_id: broadcastId,
				player: 'site',
				user_id: userId,
				live: true,
				channel: login
			}
		}
	];
	return btoa(JSON.stringify(payload));
}

export const twitchClient = new TwitchClient();
