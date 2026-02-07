import { GQL_URL, CLIENT_ID, GQL_OPERATIONS } from './constants';
import { getLogger } from './logger';

const logger = getLogger('TwitchClient');

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
				logger.error({ status: response.status, statusText: response.statusText }, 'GQL request failed');
				return { errors: [{ message: `HTTP ${response.status}` }] };
			}

			return await response.json();
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
			logger.error({ channelLogin }, 'Failed to get channel points context');
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
			logger.error({ channelId }, 'Failed to check live status');
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
			logger.warn('Cannot claim bonus - not authenticated');
			return false;
		}

		logger.info({ channelId, claimId }, 'Claiming bonus');

		const response = await this.postGqlRequest(GQL_OPERATIONS.ClaimCommunityPoints, {
			input: {
				channelID: channelId,
				claimID: claimId
			}
		});

		if (response.errors) {
			logger.error({ channelId, claimId, errors: response.errors }, 'Failed to claim bonus');
			return false;
		}

		logger.info({ channelId }, 'Successfully claimed bonus');
		return true;
	}
}

export const twitchClient = new TwitchClient();
