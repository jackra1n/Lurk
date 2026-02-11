import { randomBytes } from 'crypto';
import { GQL_URL, CLIENT_ID, CLIENT_VERSION_FALLBACK, GQL_OPERATIONS, USER_AGENT } from './constants';
import { getLogger } from './logger';

const VERSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const TWITCH_BUILD_ID_PATTERN = /window\.__twilightBuildID\s*=\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;

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
	errors?: Array<{ message: string }>;
}

export class TwitchClient {
	private authToken: string | null = null;
	private deviceId = '';
	private clientSessionId = randomBytes(16).toString('hex');
	private clientVersion = CLIENT_VERSION_FALLBACK;
	private lastVersionFetch = 0;

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
		variables?: Record<string, unknown>,
		_retried = false
	): Promise<GqlResponse<T>> {
		if (!this.authToken) {
			throw new Error('Not authenticated');
		}

		const body = {
			...operation,
			variables: variables || {}
		};

		try {
			const clientVersion = await this.fetchClientVersion();

			const response = await fetch(GQL_URL, {
				method: 'POST',
				headers: {
					Authorization: `OAuth ${this.authToken}`,
					'Client-Id': CLIENT_ID,
					'Client-Version': clientVersion,
					'Client-Session-Id': this.clientSessionId,
					'User-Agent': USER_AGENT,
					'X-Device-Id': this.deviceId,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				logger.error({ status: response.status, statusText: response.statusText }, 'GQL request failed');
				return { errors: [{ message: `HTTP ${response.status}` }] };
			}

			const result: GqlResponse<T> = await response.json();

			// try to auto-recover from stale persisted query hashes by refreshing client version
			if (
				!_retried &&
				result.errors?.some((e) => e.message === 'PersistedQueryNotFound')
			) {
				logger.warn(
					{ operation: operation.operationName },
					'PersistedQueryNotFound - refreshing client version and retrying'
				);
				await this.fetchClientVersion(true);
				return this.postGqlRequest<T>(operation, variables, true);
			}

			return result;
		} catch (error) {
			logger.error({ err: error }, 'GQL request error');
			return { errors: [{ message: String(error) }] };
		}
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
			logger.error({ login, errors: response.errors }, 'Failed to get user ID');
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
			logger.error({ channelLogin, errors: response.errors }, 'Failed to get channel points context');
			return null;
		}

		if (!response.data?.community?.channel) {
			logger.error({ channelLogin }, 'Channel points context missing channel data');
			return null;
		}

		const points = response.data.community.channel.self.communityPoints;
		return {
			balance: points.balance,
			availableClaimId: points.availableClaim?.id || null,
			activeMultipliers: points.activeMultipliers || []
		};
	}

	async getStreamInfo(channelLogin: string): Promise<StreamInfo | null> {
		if (!this.isAuthenticated()) {
			return null;
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
			logger.error({ channelLogin, errors: response.errors }, 'Failed to get stream info');
			return null;
		}

		const stream = response.data?.user?.stream;
		if (!stream) {
			return null;
		}

		return {
			broadcastId: stream.id,
			title: stream.title,
			game: stream.game,
			tags: (stream.freeformTags || []).map((t) => ({ localizedName: t.name })),
			viewersCount: stream.viewersCount
		};
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
	async getPlaybackAccessToken(login: string): Promise<{ signature: string; value: string } | null> {
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
				login: login.toLowerCase(),
				isLive: true,
				isVod: false,
				vodID: '',
				playerType: 'site'
			}
		);

		if (response.errors) {
			logger.error({ login, errors: response.errors }, 'Failed to get playback access token');
			return null;
		}

		const token = response.data?.streamPlaybackAccessToken;
		if (!token?.signature || !token?.value) {
			logger.debug({ login }, 'No playback access token returned (stream may be offline)');
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
