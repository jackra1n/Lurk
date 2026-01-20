import { getAuthToken } from './config';

export interface TwitchUser {
	id: string;
	login: string;
	displayName: string;
}

export class TwitchClient {
	private authToken: string | null = null;

	constructor() {
		this.authToken = getAuthToken();
	}

	setAuthToken(token: string): void {
		this.authToken = token;
	}

	isAuthenticated(): boolean {
		return this.authToken !== null && this.authToken.length > 0;
	}

    // TODO
	async validateToken(): Promise<boolean> {
		if (!this.authToken) {
			return false;
		}

		// TODO: Implement actual token validation with Twitch API
		// For now, just check if token exists
		console.log('[TwitchClient] Token validation stub - token present:', !!this.authToken);
		return true;
	}

	// TODO
	async getUser(login: string): Promise<TwitchUser | null> {
		if (!this.isAuthenticated()) {
			console.log('[TwitchClient] Cannot get user - not authenticated');
			return null;
		}

		// TODO: Implement actual Twitch API call
		console.log(`[TwitchClient] getUser stub called for: ${login}`);
		return {
			id: 'stub-id',
			login: login.toLowerCase(),
			displayName: login
		};
	}

    // TODO
	async isChannelLive(login: string): Promise<boolean> {
		if (!this.isAuthenticated()) {
			return false;
		}

		// TODO: Implement actual stream status check
		console.log(`[TwitchClient] isChannelLive stub called for: ${login}`);
		return false;
	}

	// TODO
	async connectPubSub(): Promise<void> {
		// TODO: Implement WebSocket connection to wss://pubsub-edge.twitch.tv
		console.log('[TwitchClient] PubSub connection stub - not yet implemented');
	}

	// TODO
	async claimBonus(channelId: string, claimId: string): Promise<boolean> {
		if (!this.isAuthenticated()) {
			return false;
		}

		// TODO: Implement actual bonus claim via Twitch GQL API
		console.log(`[TwitchClient] claimBonus stub called for channel: ${channelId}, claim: ${claimId}`);
		return true;
	}
}

export const twitchClient = new TwitchClient();
