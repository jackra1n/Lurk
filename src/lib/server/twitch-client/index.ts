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
const SPADE_URL_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const SPADE_URL_RETRY_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// every outbound fetch gets a hard deadline so a wedged socket cannot stall a caller
const fetchTimeout = (): AbortSignal => AbortSignal.timeout(FETCH_TIMEOUT_MS);

const TRANSIENT_FETCH_ERROR_CODES: Record<string, true> = {
	ECONNRESET: true,
	ETIMEDOUT: true,
	EPIPE: true,
	UND_ERR_SOCKET: true
};

export const isTransientFetchError = (error: unknown): boolean => {
	if (!(error instanceof Error)) return false;
	if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
	const cause = 'cause' in error ? error.cause : undefined;
	return (
		('code' in error &&
			typeof error.code === 'string' &&
			TRANSIENT_FETCH_ERROR_CODES[error.code] === true) ||
		(cause instanceof Error && cause !== error && isTransientFetchError(cause))
	);
};

export interface SpadeUrlCache {
	spadeUrl: string | null;
	lastSpadeUrlFetch: number;
	lastSpadeUrlAttempt: number;
}

// decide whether a cached spade URL can be reused or a scrape is needed;
// failures back off via lastSpadeUrlAttempt so callers do not hammer twitch.tv
export const shouldRefetchSpadeUrl = (cache: SpadeUrlCache, now: number): boolean => {
	const fresh = cache.spadeUrl !== null && now - cache.lastSpadeUrlFetch < SPADE_URL_REFRESH_INTERVAL_MS;
	if (fresh) return false;
	return now - cache.lastSpadeUrlAttempt >= SPADE_URL_RETRY_INTERVAL_MS;
};

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
	channelPointsEnabled: boolean | null;
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
	failure?: GqlFailure;
}

interface GqlError {
	message: string;
	path?: Array<string | number>;
}

export type GqlErrorCategory = 'transient' | 'stale_query' | 'auth' | 'fatal';

export interface GqlFailure {
	category: GqlErrorCategory;
	retryAtMs?: number;
}

interface GqlRecoveryState {
	errors: GqlError[];
	category: GqlErrorCategory;
	retryAtMs: number;
	retryAfterUntilMs: number;
	failures: number;
	owner: symbol | null;
	lastWarningAtMs: number | null;
}

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
			category?: GqlErrorCategory;
			retryAtMs?: number;
	  };

const RETRYABLE_GQL_MESSAGES: Record<string, true> = {
	'service timeout': true,
	'service unavailable': true,
	'context deadline exceeded': true,
	'service error': true,
	'server error': true
};

const AUTH_GQL_MESSAGE_PATTERNS = ['not authorized', 'unauthorized', 'authentication', 'invalid oauth', 'forbidden'];
const PERSISTED_QUERY_NOT_FOUND = 'persistedquerynotfound';
const MAX_GQL_ATTEMPTS = 4;
const GQL_RETRY_BASE_DELAY_MS = 800;
const GQL_RETRY_MAX_DELAY_MS = 10_000;
const GQL_COOLDOWN_BASE_MS = 30_000;
const GQL_COOLDOWN_MAX_MS = 5 * 60_000;
const GQL_STALE_QUERY_COOLDOWN_MS = 5 * 60_000;
const GQL_STALE_QUERY_COOLDOWN_MAX_MS = 30 * 60_000;
const GQL_WARNING_INTERVAL_MS = 5 * 60_000;
const VERSION_RETRY_INTERVAL_MS = 60_000;

export const parseRetryAfterMs = (value: string | null, nowMs = Date.now()): number => {
	if (!value?.trim()) return 0;
	const trimmed = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const delay = Number(trimmed) * 1000;
		return Number.isFinite(delay) ? delay : 0;
	}
	// Do not let Date.parse interpret malformed delta-seconds as calendar dates.
	if (!/[a-z]/i.test(trimmed)) return 0;
	const date = Date.parse(trimmed);
	return Number.isFinite(date) ? Math.max(0, date - nowMs) : 0;
};

const normalizeErrorMessage = (message: string) => message.trim().toLowerCase();

const jitterDelay = (delayMs: number) => {
	const jitter = (Math.random() * 0.4) - 0.2;
	return Math.max(200, Math.round(delayMs * (1 + jitter)));
};

const summarizeGqlErrors = (errors: GqlError[]) =>
	[...new Set(errors.map((error) => error.message))].slice(0, 4);

// playlists can end with tags like #EXT-X-TWITCH-PREFETCH or #EXT-X-ENDLIST
export const lastUrlLine = (playlist: string): string | null => {
	const lines = playlist.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.length > 0 && !line.startsWith('#')) {
			return line;
		}
	}
	return null;
};

export function classifyGqlErrors(errors: GqlError[]): GqlErrorSummary {
	// Classify every error before abbreviating diagnostics: auth/permanent errors
	// must not be masked by a transient error earlier in a mixed response.
	const categories = errors.map(({ message }) => {
		const normalized = normalizeErrorMessage(message);
		if (AUTH_GQL_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern))) return 'auth';
		if (normalized.includes(PERSISTED_QUERY_NOT_FOUND)) return 'stale_query';
		if (
			RETRYABLE_GQL_MESSAGES[normalized] === true ||
			normalized.includes('persistedqueryunavailable') ||
			/\bsubgraph\b.*\b(error|unavailable|timeout|failed|failure)\b/.test(normalized) ||
			/\b(error|failed|failure)\b.*\bsubgraph\b/.test(normalized)
		) return 'transient';
		return 'fatal';
	});
	const category: GqlErrorCategory = categories.includes('auth') ? 'auth'
		: categories.includes('fatal') || categories.length === 0 ? 'fatal'
		: categories.includes('stale_query') ? 'stale_query' : 'transient';
	return {
		category,
		retryable: category === 'transient' || category === 'stale_query',
		persistedQueryNotFound: category === 'stale_query',
		messages: summarizeGqlErrors(errors)
	};
}

export class TwitchClient {
	private authToken: string | null = null;
	private deviceId = '';
	private clientSessionId = randomBytes(16).toString('hex');
	private clientVersion = CLIENT_VERSION_FALLBACK;
	private lastVersionFetch = 0;
	private lastVersionAttempt = -Infinity;
	private versionFetch: Promise<string> | null = null;
	private readonly gqlRecovery = new Map<string, GqlRecoveryState>();
	spadeUrl: string | null = null;
	lastSpadeUrlFetch = 0;
	lastSpadeUrlAttempt = 0;
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
		if (token !== this.authToken) this.gqlRecovery.clear();
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
		if (this.versionFetch) return this.versionFetch;
		const now = Date.now();
		if (
			now - this.lastVersionAttempt < VERSION_RETRY_INTERVAL_MS ||
			(!force && now - this.lastVersionFetch < VERSION_REFRESH_INTERVAL_MS)
		) return this.clientVersion;
		this.lastVersionAttempt = now;
		this.versionFetch = this.refreshClientVersion(now);
		try {
			return await this.versionFetch;
		} finally {
			this.versionFetch = null;
		}
	}

	private async refreshClientVersion(now: number): Promise<string> {
		try {
			const response = await fetch('https://www.twitch.tv', {
				headers: { 'User-Agent': USER_AGENT },
				signal: fetchTimeout()
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
			logger.debug(
				isTransientFetchError(error) ? { error: String(error) } : { err: error },
				'Error fetching client version'
			);
			return this.clientVersion;
		}
	}

	private deferredGqlResponse<T>(state: GqlRecoveryState): GqlResponse<T> {
		return {
			errors: state.errors,
			failure: { category: state.category, retryAtMs: state.retryAtMs }
		};
	}

	private coolDownGqlOperation<T>(name: string, state: GqlRecoveryState): GqlResponse<T> {
		state.failures += 1;
		const staleQuery = state.category === 'stale_query';
		const base = staleQuery ? GQL_STALE_QUERY_COOLDOWN_MS : GQL_COOLDOWN_BASE_MS;
		const cap = staleQuery ? GQL_STALE_QUERY_COOLDOWN_MAX_MS : GQL_COOLDOWN_MAX_MS;
		const cooldownMs = Math.min(cap, jitterDelay(Math.min(cap, base * 2 ** Math.min(20, state.failures - 1))));
		state.retryAtMs = Math.max(Date.now() + cooldownMs, state.retryAfterUntilMs);
		state.owner = null;
		if (state.lastWarningAtMs === null || Date.now() - state.lastWarningAtMs >= GQL_WARNING_INTERVAL_MS) {
			state.lastWarningAtMs = Date.now();
			logger.warn(
				{ operation: name, category: state.category, failures: state.failures, retryAtMs: state.retryAtMs, errors: summarizeGqlErrors(state.errors) },
				staleQuery
					? 'Persisted query remains unsupported; deferring version refresh and recovery probe'
					: 'GQL operation unavailable; deferring requests until recovery probe'
			);
		}
		return this.deferredGqlResponse(state);
	}

	private async postGqlRequest<T = unknown>(
		operation: (typeof GQL_OPERATIONS)[keyof typeof GQL_OPERATIONS],
		variables?: Record<string, unknown>
	): Promise<GqlResponse<T>> {
		if (!this.authToken) throw new Error('Not authenticated');
		const authToken = this.authToken;
		const name = operation.operationName;
		const owner = Symbol(name);
		let state = this.gqlRecovery.get(name);
		if (state && (state.owner !== null || Date.now() < state.retryAtMs)) {
			return this.deferredGqlResponse(state);
		}
		const probe = state !== undefined;
		if (state) state.owner = owner;
		// A failed mutation may already have committed. Never replay it automatically.
		const replaySafe = name !== GQL_OPERATIONS.ClaimCommunityPoints.operationName;
		const maxAttempts = probe || !replaySafe ? 1 : MAX_GQL_ATTEMPTS;
		const body = JSON.stringify({ ...operation, variables: variables || {} });
		let refreshedForPersistedQuery = false;

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			// Another already-in-flight response may extend Retry-After while the
			// owner sleeps. Recheck it before sending, not just when first received.
			if (state && state.retryAfterUntilMs > Date.now()) {
				const remainingMs = state.retryAfterUntilMs - Date.now();
				if (remainingMs > GQL_RETRY_MAX_DELAY_MS) return this.coolDownGqlOperation(name, state);
				await this.sleep(remainingMs);
			}
			let result: GqlResponse<T>;
			let category: GqlErrorCategory;
			let retryAfterMs = 0;
			let unexpectedError: unknown;
			try {
				const clientVersion = await this.fetchClientVersion(probe && state?.category === 'stale_query');
				let deferred: GqlResponse<T> | undefined;
				const { value: response, waitMs, queueDepthAtEnqueue } = await this.gqlLimiter.schedule(name, () => {
					// A request queued while healthy must not leak through after another
					// channel discovers the outage and takes ownership of recovery.
					const current = this.gqlRecovery.get(name);
					if (current && current.owner !== owner) {
						deferred = this.deferredGqlResponse(current);
						return Promise.resolve(null);
					}
					if (current && current.retryAfterUntilMs > Date.now()) {
						deferred = this.coolDownGqlOperation(name, current);
						return Promise.resolve(null);
					}
					return fetch(GQL_URL, {
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
						body,
						signal: fetchTimeout()
					});
				});
				if (!response) return deferred!;
				logger.debug(
					{ operation: name, attempt, probe, waitMs, queueDepth: queueDepthAtEnqueue },
					'GQL request sent via rate limiter'
				);
				retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
				if (!response.ok) {
					result = { errors: [{ message: `HTTP ${response.status}` }] };
					category = response.status === 401 || response.status === 403 ? 'auth'
						: response.status === 408 || response.status === 429 || response.status >= 500
							? 'transient' : 'fatal';
				} else {
					result = await response.json();
					if (!result || typeof result !== 'object' ||
						(result.errors !== undefined && (!Array.isArray(result.errors) ||
							result.errors.some((error) => !error || typeof error.message !== 'string')))) {
						throw new Error('Invalid GQL response');
					}
					if (!result.errors?.length) {
						// A late success from a different request cannot clear an active
						// recovery loop; only its owner can establish recovery.
						const current = this.gqlRecovery.get(name);
						if (current?.owner === owner) {
							this.gqlRecovery.delete(name);
							if (current.lastWarningAtMs !== null) {
								logger.info({ operation: name }, 'GQL operation recovered');
							}
						}
						return result;
					}
					category = classifyGqlErrors(result.errors).category;
				}
			} catch (error) {
				const transient = isTransientFetchError(error) || error instanceof RateLimiterQueueFullError;
				category = transient ? 'transient' : 'fatal';
				result = { errors: [{ message: String(error) }] };
				if (!transient) unexpectedError = error;
			}

			if (category === 'auth' || category === 'fatal') {
				if (this.gqlRecovery.get(name)?.owner === owner) this.gqlRecovery.delete(name);
				logger.error(
					{ operation: name, category, errors: [...new Set(result.errors!.map((error) => error.message))], ...(unexpectedError ? { err: unexpectedError } : {}) },
					'GQL request failed with non-retryable errors'
				);
				return { ...result, failure: { category } };
			}

			if (authToken !== this.authToken) return { ...result, failure: { category } };
			const current = this.gqlRecovery.get(name);
			if (current && current.owner !== owner) {
				current.retryAfterUntilMs = Math.max(current.retryAfterUntilMs, Date.now() + retryAfterMs);
				current.retryAtMs = Math.max(current.retryAtMs, current.retryAfterUntilMs);
				return this.deferredGqlResponse(current);
			}
			state = current ?? {
				errors: result.errors!,
				category,
				retryAtMs: Date.now(),
				retryAfterUntilMs: 0,
				failures: 0,
				owner,
				lastWarningAtMs: null
			};
			state.errors = result.errors!;
			state.category = category;
			state.retryAfterUntilMs = Math.max(state.retryAfterUntilMs, Date.now() + retryAfterMs);
			this.gqlRecovery.set(name, state);

			const staleQuery = category === 'stale_query';
			const canRetry = attempt < maxAttempts &&
				(!staleQuery || !refreshedForPersistedQuery) &&
				retryAfterMs <= GQL_RETRY_MAX_DELAY_MS;
			if (canRetry) {
				const delayMs = Math.max(this.retryDelayMs(attempt), retryAfterMs);
				state.retryAtMs = Date.now() + delayMs;
				logger.debug(
					{ operation: name, attempt, category, nextRetryInMs: delayMs, errors: summarizeGqlErrors(state.errors) },
					'Transient GQL failure, retrying'
				);
				if (staleQuery) {
					refreshedForPersistedQuery = true;
					await this.fetchClientVersion(true);
				}
				await this.sleep(Math.max(0, state.retryAtMs - Date.now()));
				continue;
			}

			return this.coolDownGqlOperation(name, state);
		}
		throw new Error('Unreachable GQL retry state');
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
					communityPointsSettings?: {
						isEnabled?: boolean | null;
					} | null;
				};
			} | null;
		}

		const response = await this.postGqlRequest<ChannelPointsResponse>(
			GQL_OPERATIONS.ChannelPointsContext,
			{ channelLogin: channelLogin.toLowerCase() }
		);

		if (response.errors) {
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
			activeMultipliers: points.activeMultipliers || [],
			channelPointsEnabled: response.data.community.channel.communityPointsSettings?.isEnabled ?? null
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

		if (response.errors?.length) {
			return {
				kind: 'unknown',
				reason: 'gql_error',
				errors: response.errors,
				...response.failure
			};
		}

		const stream = response.data?.user?.stream;
		if (stream === null) return { kind: 'offline' };
		if (
			!stream || typeof stream.id !== 'string' || !stream.id ||
			typeof stream.title !== 'string' || !Number.isFinite(stream.viewersCount) ||
			(stream.game !== null && (!stream.game || typeof stream.game.displayName !== 'string')) ||
			(stream.freeformTags !== undefined && (!Array.isArray(stream.freeformTags) ||
				stream.freeformTags.some((tag) => !tag || typeof tag.name !== 'string')))
		) {
			logger.error({ operation: GQL_OPERATIONS.VideoPlayerStreamInfoOverlayChannel.operationName }, 'Invalid stream info response');
			return {
				kind: 'unknown',
				reason: 'gql_error',
				category: 'fatal',
				errors: [{ message: 'InvalidStreamInfoResponse' }]
			};
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
			return { ok: false, reason: 'gql_error', errors: response.errors };
		}

		return { ok: true };
	}

	// spade_url lives in Twitch's global settings JS -- same value for every channel
	async getSpadeUrl(): Promise<string | null> {
		const now = Date.now();
		if (!shouldRefetchSpadeUrl(this, now)) {
			return this.spadeUrl;
		}
		this.lastSpadeUrlAttempt = now;

		try {
			const headers = { 'User-Agent': USER_AGENT };

			const pageResponse = await fetch('https://www.twitch.tv', {
				headers,
				redirect: 'follow',
				signal: fetchTimeout()
			});
			if (!pageResponse.ok) {
				logger.error({ status: pageResponse.status }, 'Failed to fetch twitch.tv for spade URL');
				return this.spadeUrl;
			}
			const pageHtml = await pageResponse.text();

			const settingsMatch = pageHtml.match(
				/(https:\/\/static\.twitchcdn\.net\/config\/settings.*?js|https:\/\/assets\.twitch\.tv\/config\/settings.*?\.js)/
			);
			if (!settingsMatch) {
				logger.error('Could not find settings JS URL in twitch.tv page');
				return this.spadeUrl;
			}

			const settingsResponse = await fetch(settingsMatch[1], { headers, signal: fetchTimeout() });
			if (!settingsResponse.ok) {
				logger.error({ status: settingsResponse.status }, 'Failed to fetch settings JS');
				return this.spadeUrl;
			}
			const settingsJs = await settingsResponse.text();

			const spadeMatch = settingsJs.match(/"spade_url":"(.*?)"/);
			if (!spadeMatch) {
				logger.error('Could not find spade_url in settings JS');
				return this.spadeUrl;
			}

			this.spadeUrl = spadeMatch[1];
			this.lastSpadeUrlFetch = now;
			logger.debug({ spadeUrl: this.spadeUrl }, 'Got spade URL');
			return this.spadeUrl;
		} catch (error) {
			if (isTransientFetchError(error)) {
				logger.warn({ error: String(error) }, 'Transient failure fetching spade URL');
			} else {
				logger.error({ err: error }, 'Error fetching spade URL');
			}
			return this.spadeUrl;
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
			return null;
		}

		const token = response.data?.streamPlaybackAccessToken;
		if (!token?.signature || !token?.value) {
			logger.debug({ login: streamerName }, 'No playback access token returned (stream may be offline)');
			return null;
		}

		return { signature: token.signature, value: token.value };
	}

	// resolve the lowest quality variant playlist URL from the HLS master manifest;
	// stable for the lifetime of a broadcast, so callers should cache it
	async fetchLowestQualityPlaylistUrl(
		login: string,
		signature: string,
		value: string
	): Promise<string | null> {
		try {
			const masterUrl =
				`https://usher.ttvnw.net/api/channel/hls/${login.toLowerCase()}.m3u8` +
				`?sig=${signature}&token=${encodeURIComponent(value)}`;

			const response = await fetch(masterUrl, {
				headers: { 'User-Agent': USER_AGENT },
				redirect: 'follow',
				signal: fetchTimeout()
			});
			if (!response.ok) {
				logger.debug({ login, status: response.status }, 'Failed to fetch HLS master manifest');
				return null;
			}
			const masterPlaylist = await response.text();

			const lowestQualityUrl = lastUrlLine(masterPlaylist);
			if (!lowestQualityUrl) {
				logger.debug({ login }, 'No stream URL found in master manifest');
				return null;
			}

			return lowestQualityUrl;
		} catch (error) {
			if (isTransientFetchError(error)) {
				logger.warn({ error: String(error), login }, 'Transient failure fetching lowest quality playlist URL');
			} else {
				logger.error({ err: error, login }, 'Error fetching lowest quality playlist URL');
			}
			return null;
		}
	}

	// fetch the variant playlist and HEAD its newest segment to simulate watching
	async touchStreamSegment(login: string, playlistUrl: string): Promise<boolean> {
		try {
			const headers = { 'User-Agent': USER_AGENT };

			const playlistResponse = await fetch(playlistUrl, {
				headers,
				redirect: 'follow',
				signal: fetchTimeout()
			});
			if (!playlistResponse.ok) {
				logger.debug({ login, status: playlistResponse.status }, 'Failed to fetch variant playlist');
				return false;
			}
			const playlist = await playlistResponse.text();

			const segmentUrl = lastUrlLine(playlist);
			if (!segmentUrl) {
				logger.debug({ login }, 'No stream segment URL found in variant playlist');
				return false;
			}

			const headResponse = await fetch(segmentUrl, {
				method: 'HEAD',
				headers,
				redirect: 'follow',
				signal: fetchTimeout()
			});
			if (!headResponse.ok) {
				logger.debug({ login, status: headResponse.status }, 'Stream segment URL HEAD check failed');
				return false;
			}

			return true;
		} catch (error) {
			if (isTransientFetchError(error)) {
				logger.warn({ error: String(error), login }, 'Transient failure touching stream segment');
			} else {
				logger.error({ err: error, login }, 'Error touching stream segment');
			}
			return false;
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
				body: new URLSearchParams({ data: encodedPayload }),
				signal: fetchTimeout()
			});

			return response.status === 204;
		} catch (error) {
			if (isTransientFetchError(error)) {
				logger.debug('Transient network failure sending minute-watched event');
			} else {
				logger.error({ err: error }, 'Error sending minute-watched event');
			}
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
