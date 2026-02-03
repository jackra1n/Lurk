import { getAuthToken } from './config';
import { GQL_URL, CLIENT_ID, GQL_OPERATIONS } from './constants';

export interface TwitchUser {
	id: string;
	login: string;
	displayName: string;
}

export interface ChannelPointsContext {
	balance: number;
	availableClaimId: string | null;
}

interface GqlResponse<T = unknown> {
	data?: T;
	errors?: Array<{ message: string }>;
}

export class TwitchClient {
	private authToken: string | null = null;

	constructor() {
		this.authToken = getAuthToken();
	}

	setAuthToken(token: string): void {
		this.authToken = token;
	}

	getAuthToken(): string | null {
		return this.authToken;
	}

	isAuthenticated(): boolean {
		return this.authToken !== null && this.authToken.length > 0;
	}

	private async postGqlRequest<T = unknown>(
		operation: (typeof GQL_OPERATIONS)[keyof typeof GQL_OPERATIONS],
		variables?: Record<string, unknown>
	): Promise<GqlResponse<T>> {
		if (!this.authToken) {
			throw new Error('Not authenticated');
		}

		const body = {
			...operation,
			variables: variables || {}
		};

		try {
			const response = await fetch(GQL_URL, {
				method: 'POST',
				headers: {
					Authorization: `OAuth ${this.authToken}`,
					'Client-Id': CLIENT_ID,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				console.error(`[TwitchClient] GQL request failed: ${response.status} ${response.statusText}`);
				return { errors: [{ message: `HTTP ${response.status}` }] };
			}

			return await response.json();
		} catch (error) {
			console.error(`[TwitchClient] GQL request error:`, error);
			return { errors: [{ message: String(error) }] };
		}
	}

	async validateToken(): Promise<boolean> {
		if (!this.authToken) {
			return false;
		}

		try {
			const response = await this.postGqlRequest(GQL_OPERATIONS.GetIDFromLogin, {
				login: 'twitch' // Just a test query
			});

			if (response.errors && response.errors.length > 0) {
				console.error('[TwitchClient] Token validation failed:', response.errors);
				return false;
			}

			console.log('[TwitchClient] Token validated successfully');
			return true;
		} catch {
			return false;
		}
	}

	async getUserId(login: string): Promise<string | null> {
		if (!this.isAuthenticated()) {
			console.log('[TwitchClient] Cannot get user ID - not authenticated');
			return null;
		}

		const response = await this.postGqlRequest<{ user: { id: string } | null }>(
			GQL_OPERATIONS.GetIDFromLogin,
			{ login: login.toLowerCase() }
		);

		if (response.errors) {
			console.error(`[TwitchClient] Failed to get user ID for ${login}:`, response.errors);
			return null;
		}

		const userId = response.data?.user?.id;
		if (!userId) {
			console.log(`[TwitchClient] User not found: ${login}`);
			return null;
		}

		console.log(`[TwitchClient] Got user ID for ${login}: ${userId}`);
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
						};
					};
				};
			} | null;
		}

		const response = await this.postGqlRequest<ChannelPointsResponse>(
			GQL_OPERATIONS.ChannelPointsContext,
			{ channelLogin: channelLogin.toLowerCase() }
		);

		if (response.errors || !response.data?.community?.channel) {
			console.error(`[TwitchClient] Failed to get channel points context for ${channelLogin}`);
			return null;
		}

		const points = response.data.community.channel.self.communityPoints;
		return {
			balance: points.balance,
			availableClaimId: points.availableClaim?.id || null
		};
	}

	async isChannelLiveById(channelId: string): Promise<boolean> {
		if (!this.isAuthenticated()) {
			return false;
		}

		interface StreamLiveResponse {
			user: {
				stream: { id: string } | null;
			} | null;
		}

		const response = await this.postGqlRequest<StreamLiveResponse>(
			GQL_OPERATIONS.WithIsStreamLiveQuery,
			{ id: channelId }
		);

		if (response.errors) {
			console.error(`[TwitchClient] Failed to check live status for channel ${channelId}`);
			return false;
		}

		const isLive = response.data?.user?.stream !== null;
		return isLive;
	}

	async isChannelLive(login: string): Promise<boolean> {
		const channelId = await this.getUserId(login);
		if (!channelId) {
			return false;
		}
		return this.isChannelLiveById(channelId);
	}

	async claimBonus(channelId: string, claimId: string): Promise<boolean> {
		if (!this.isAuthenticated()) {
			console.log('[TwitchClient] Cannot claim bonus - not authenticated');
			return false;
		}

		console.log(`[TwitchClient] Claiming bonus for channel ${channelId}, claim ${claimId}`);

		const response = await this.postGqlRequest(GQL_OPERATIONS.ClaimCommunityPoints, {
			input: {
				channelID: channelId,
				claimID: claimId
			}
		});

		if (response.errors) {
			console.error(`[TwitchClient] Failed to claim bonus:`, response.errors);
			return false;
		}

		console.log(`[TwitchClient] Successfully claimed bonus for channel ${channelId}`);
		return true;
	}
}

export const twitchClient = new TwitchClient();
