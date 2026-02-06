import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
	CLIENT_ID,
	OAUTH_DEVICE_URL,
	OAUTH_TOKEN_URL,
	OAUTH_SCOPES,
	USER_AGENT
} from './constants';

const AUTH_PATH = join(process.cwd(), 'auth.json');
const COOKIES_PATH = join(process.cwd(), 'cookies.json');

export interface DeviceCodeResponse {
	device_code: string;
	expires_in: number;
	interval: number;
	user_code: string;
	verification_uri: string;
}

export interface TokenResponse {
	access_token: string;
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

interface PersistedAuth {
	accessToken: string | null;
	userId: string | null;
	username: string | null;
	deviceId: string | null;
}

const defaultPersistedAuth: PersistedAuth = {
	accessToken: null,
	userId: null,
	username: null,
	deviceId: null
};

function loadPersistedAuth(): PersistedAuth {
	if (!existsSync(AUTH_PATH)) {
		return { ...defaultPersistedAuth };
	}

	try {
		const raw = readFileSync(AUTH_PATH, 'utf-8');
		return { ...defaultPersistedAuth, ...JSON.parse(raw) };
	} catch {
		return { ...defaultPersistedAuth };
	}
}

function savePersistedAuth(auth: PersistedAuth): void {
	writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), 'utf-8');
}

function loadPersistedCookies(): string[] {
	if (!existsSync(COOKIES_PATH)) {
		return [];
	}

	try {
		const raw = readFileSync(COOKIES_PATH, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((cookie): cookie is string => typeof cookie === 'string');
	} catch {
		return [];
	}
}

function savePersistedCookies(cookies: string[]): void {
	writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
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

interface TokenValidationResult {
	valid: boolean;
	status?: number;
	userId?: string;
	username?: string;
}

class TwitchAuth {
	private pendingAuth: PendingAuth | null = null;
	private persisted: PersistedAuth;

	constructor() {
		this.persisted = loadPersistedAuth();
		if (!this.persisted.deviceId) {
			this.persisted.deviceId = this.generateDeviceId();
			this.save();
		}
	}

	private generateDeviceId(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	private save(): void {
		savePersistedAuth(this.persisted);
	}

	private getDeviceId(): string {
		if (!this.persisted.deviceId) {
			this.persisted.deviceId = this.generateDeviceId();
			this.save();
		}
		return this.persisted.deviceId;
	}

	private async validateAccessToken(accessToken: string): Promise<TokenValidationResult> {
		const response = await fetch('https://id.twitch.tv/oauth2/validate', {
			headers: {
				Authorization: `OAuth ${accessToken}`
			}
		});

		if (!response.ok) {
			return {
				valid: false,
				status: response.status
			};
		}

		const data = await response.json();
		return {
			valid: true,
			userId: data.user_id,
			username: data.login
		};
	}

	private saveValidatedUser(userId?: string, username?: string): void {
		if (!userId) {
			return;
		}

		this.persisted.userId = userId;
		this.persisted.username = username ?? null;
		this.save();
	}

	getAuthToken(): string | null {
		return this.persisted.accessToken;
	}

	getUserId(): string | null {
		return this.persisted.userId;
	}

	getCookies(): string[] {
		return loadPersistedCookies();
	}

	setCookies(cookies: string[]): void {
		savePersistedCookies(cookies.filter((cookie): cookie is string => typeof cookie === 'string'));
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
				'X-Device-Id': this.getDeviceId()
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
							'X-Device-Id': this.getDeviceId()
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

					this.persisted.accessToken = tokenData.access_token;
					this.save();

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
			const validation = await this.validateAccessToken(accessToken);
			if (validation.valid && validation.userId) {
				this.saveValidatedUser(validation.userId, validation.username);
				console.log(`[Auth] User ID: ${validation.userId}, Username: ${validation.username}`);
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
		return {
			authenticated: !!this.persisted.accessToken,
			userId: this.persisted.userId,
			username: this.persisted.username,
			pendingLogin: this.pendingAuth !== null,
			userCode: this.pendingAuth?.userCode || null,
			verificationUri: this.pendingAuth ? 'https://www.twitch.tv/activate' : null,
			expiresAt: this.pendingAuth?.expiresAt || null
		};
	}

	async validateToken(): Promise<boolean> {
		const token = this.persisted.accessToken;
		if (!token) return false;

		try {
			const validation = await this.validateAccessToken(token);
			if (validation.valid) {
				this.saveValidatedUser(validation.userId, validation.username);
				return true;
			}

			console.log('[Auth] Token validation failed:', validation.status);
			return false;
		} catch (error) {
			console.error('[Auth] Token validation error:', error);
			return false;
		}
	}

	logout(): void {
		this.cancelPendingAuth();
		const previousDeviceId = this.getDeviceId();
		this.persisted = { ...defaultPersistedAuth, deviceId: previousDeviceId };
		this.save();
		savePersistedCookies([]);
		console.log('[Auth] Logged out');
	}
}

export const twitchAuth = new TwitchAuth();
