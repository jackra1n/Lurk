import {
	CLIENT_ID,
	OAUTH_DEVICE_URL,
	OAUTH_TOKEN_URL,
	OAUTH_SCOPES,
	USER_AGENT,
	GQL_URL,
	GQL_OPERATIONS
} from './constants';
import { setAuthToken, setUserId, getAuthToken, getUserId } from './config';

export interface DeviceCodeResponse {
	device_code: string;
	expires_in: number;
	interval: number;
	user_code: string;
	verification_uri: string;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string[];
	token_type: string;
}

export interface AuthStatus {
	authenticated: boolean;
	userId: string | null;
	username: string | null;
	pendingLogin: boolean;
	userCode: string | null;
	verificationUri: string | null;
	expiresAt: Date | null;
}

interface PendingAuth {
	deviceCode: string;
	userCode: string;
	interval: number;
	expiresAt: Date;
	pollingTimer: ReturnType<typeof setInterval> | null;
	resolve: (token: string) => void;
	reject: (error: Error) => void;
}

class TwitchAuth {
	private pendingAuth: PendingAuth | null = null;
	private username: string | null = null;
	private deviceId: string;

	constructor() {
		this.deviceId = this.generateDeviceId();
	}

	private generateDeviceId(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	/**
	 * Start the OAuth2 Device Authorization Grant flow
	 * Returns the user code and verification URL for the user to complete login
	 */
	async startDeviceFlow(): Promise<DeviceCodeResponse> {
		this.cancelPendingAuth();

		console.log('[Auth] Starting device authorization flow...');

		const response = await fetch(OAUTH_DEVICE_URL, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
				'Client-Id': CLIENT_ID,
				'User-Agent': USER_AGENT,
				'X-Device-Id': this.deviceId
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				scopes: OAUTH_SCOPES
			})
		});

		if (!response.ok) {
			const text = await response.text();
			console.error('[Auth] Device flow request failed:', response.status, text);
			throw new Error(`Device flow request failed: ${response.status}`);
		}

		const data: DeviceCodeResponse = await response.json();
		console.log('[Auth] Got device code, user should visit:', data.verification_uri);
		console.log('[Auth] User code:', data.user_code);

		return data;
	}

	/**
	 * Poll for token after user completes authorization
	 * Returns when the user completes login or when it times out
	 */
	async pollForToken(deviceCodeResponse: DeviceCodeResponse): Promise<string> {
		return new Promise((resolve, reject) => {
			const expiresAt = new Date(Date.now() + deviceCodeResponse.expires_in * 1000);

			this.pendingAuth = {
				deviceCode: deviceCodeResponse.device_code,
				userCode: deviceCodeResponse.user_code,
				interval: deviceCodeResponse.interval,
				expiresAt,
				pollingTimer: null,
				resolve,
				reject
			};

			const poll = async () => {
				if (!this.pendingAuth) return;

				if (new Date() >= this.pendingAuth.expiresAt) {
					this.cancelPendingAuth();
					reject(new Error('Device code expired'));
					return;
				}

				try {
					const response = await fetch(OAUTH_TOKEN_URL, {
						method: 'POST',
						headers: {
							Accept: 'application/json',
							'Content-Type': 'application/x-www-form-urlencoded',
							'Client-Id': CLIENT_ID,
							'User-Agent': USER_AGENT,
							'X-Device-Id': this.deviceId
						},
						body: new URLSearchParams({
							client_id: CLIENT_ID,
							device_code: this.pendingAuth.deviceCode,
							grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
						})
					});

					if (response.status === 400) {
						// User hasn't completed auth yet, continue polling
						this.pendingAuth.pollingTimer = setTimeout(poll, this.pendingAuth.interval * 1000);
						return;
					}

					if (!response.ok) {
						const text = await response.text();
						console.error('[Auth] Token request failed:', response.status, text);
						this.cancelPendingAuth();
						reject(new Error(`Token request failed: ${response.status}`));
						return;
					}

					const tokenData: TokenResponse = await response.json();
					console.log('[Auth] Got access token!');

					setAuthToken(tokenData.access_token);

					await this.fetchAndSaveUserId(tokenData.access_token);

					this.cancelPendingAuth();
					resolve(tokenData.access_token);
				} catch (error) {
					console.error('[Auth] Polling error:', error);
					// Continue polling on network errors
					if (this.pendingAuth) {
						this.pendingAuth.pollingTimer = setTimeout(poll, this.pendingAuth.interval * 1000);
					}
				}
			};

			// Initial poll after the interval
			this.pendingAuth.pollingTimer = setTimeout(poll, deviceCodeResponse.interval * 1000);
		});
	}

	/**
	 * Fetch the user ID using the access token and save it
	 */
	private async fetchAndSaveUserId(accessToken: string): Promise<void> {
		try {
			// Use GQL to get user info
			const response = await fetch(GQL_URL, {
				method: 'POST',
				headers: {
					Authorization: `OAuth ${accessToken}`,
					'Client-Id': CLIENT_ID,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					...GQL_OPERATIONS.GetIDFromLogin,
					variables: { login: '' } // Empty login returns current user? Let's try a different approach
				})
			});

			// Alternative: Validate token endpoint returns user info
			const validateResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
				headers: {
					Authorization: `OAuth ${accessToken}`
				}
			});

			if (validateResponse.ok) {
				const data = await validateResponse.json();
				if (data.user_id) {
					setUserId(data.user_id);
					this.username = data.login;
					console.log(`[Auth] User ID: ${data.user_id}, Username: ${data.login}`);
				}
			}
		} catch (error) {
			console.error('[Auth] Failed to fetch user ID:', error);
		}
	}

	cancelPendingAuth(): void {
		if (this.pendingAuth?.pollingTimer) {
			clearTimeout(this.pendingAuth.pollingTimer);
		}
		this.pendingAuth = null;
	}

	getStatus(): AuthStatus {
		const token = getAuthToken();
		const userId = getUserId();

		return {
			authenticated: !!token,
			userId,
			username: this.username,
			pendingLogin: this.pendingAuth !== null,
			userCode: this.pendingAuth?.userCode || null,
			verificationUri: this.pendingAuth ? 'https://www.twitch.tv/activate' : null,
			expiresAt: this.pendingAuth?.expiresAt || null
		};
	}

	async validateToken(): Promise<boolean> {
		const token = getAuthToken();
		if (!token) return false;

		try {
			const response = await fetch('https://id.twitch.tv/oauth2/validate', {
				headers: {
					Authorization: `OAuth ${token}`
				}
			});

			if (response.ok) {
				const data = await response.json();
				if (data.user_id) {
					setUserId(data.user_id);
					this.username = data.login;
				}
				return true;
			}

			console.log('[Auth] Token validation failed:', response.status);
			return false;
		} catch (error) {
			console.error('[Auth] Token validation error:', error);
			return false;
		}
	}

	logout(): void {
		this.cancelPendingAuth();
		setAuthToken('');
		setUserId('');
		this.username = null;
		console.log('[Auth] Logged out');
	}
}

export const twitchAuth = new TwitchAuth();
