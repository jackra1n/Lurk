import { PUBSUB_URL, type PubSubMessage } from './constants';
import { getLogger } from './logger';

export type MessageHandler = (topic: string, messageType: string, data: unknown) => void;

const logger = getLogger('PubSub');

interface PendingListen {
	topic: string;
	authToken?: string;
	resolve: () => void;
	reject: (error: Error) => void;
}

export class TwitchPubSub {
	private ws: WebSocket | null = null;
	private pingInterval: ReturnType<typeof setInterval> | null = null;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private lastPong: number = 0;
	private isConnected: boolean = false;
	private isReconnecting: boolean = false;
	private forcedClose: boolean = false;

	private topics: string[] = [];
	private pendingListens: Map<string, PendingListen> = new Map();
	private authToken: string | null = null;

	private onMessageHandler: MessageHandler | null = null;
	private onConnectedHandler: (() => void) | null = null;
	private onDisconnectedHandler: (() => void) | null = null;

	constructor() {}

	/**
	 * Set the auth token for authenticated topics
	 */
	setAuthToken(token: string): void {
		this.authToken = token;
	}

	/**
	 * Set handler for incoming messages
	 */
	onMessage(handler: MessageHandler): void {
		this.onMessageHandler = handler;
	}

	/**
	 * Set handler for connection established
	 */
	onConnected(handler: () => void): void {
		this.onConnectedHandler = handler;
	}

	/**
	 * Set handler for disconnection
	 */
	onDisconnected(handler: () => void): void {
		this.onDisconnectedHandler = handler;
	}

	/**
	 * Connect to Twitch PubSub
	 */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.ws && this.isConnected) {
				resolve();
				return;
			}

			this.forcedClose = false;
			logger.info({ url: PUBSUB_URL }, 'Connecting');

			this.ws = new WebSocket(PUBSUB_URL);

			this.ws.onopen = () => {
				logger.info('Connected');
				this.isConnected = true;
				this.isReconnecting = false;
				this.lastPong = Date.now();
				this.startPingLoop();
				this.onConnectedHandler?.();
				resolve();
			};

			this.ws.onmessage = (event) => {
				this.handleMessage(event.data);
			};

			this.ws.onerror = (error) => {
				logger.error({ err: error }, 'WebSocket error');
				if (!this.isConnected) {
					reject(new Error('Failed to connect'));
				}
			};

			this.ws.onclose = () => {
				logger.info('Connection closed');
				this.isConnected = false;
				this.stopPingLoop();
				this.onDisconnectedHandler?.();

				if (!this.forcedClose) {
					this.scheduleReconnect();
				}
			};
		});
	}

	/**
	 * Disconnect from PubSub
	 */
	disconnect(): void {
		logger.info('Disconnecting');
		this.forcedClose = true;
		this.stopPingLoop();

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.isConnected = false;
		this.topics = [];
		this.pendingListens.clear();
	}

	/**
	 * Listen to a topic
	 */
	async listen(topic: string, requiresAuth: boolean = false): Promise<void> {
		if (!this.isConnected || !this.ws) {
			throw new Error('Not connected to PubSub');
		}

		if (this.topics.includes(topic)) {
			logger.debug({ topic }, 'Already listening to topic');
			return;
		}

		return new Promise((resolve, reject) => {
			const nonce = this.generateNonce();

			this.pendingListens.set(nonce, {
				topic,
				authToken: requiresAuth ? this.authToken || undefined : undefined,
				resolve,
				reject
			});

			const request: { type: string; nonce: string; data: { topics: string[]; auth_token?: string } } = {
				type: 'LISTEN',
				nonce,
				data: {
					topics: [topic]
				}
			};

			if (requiresAuth && this.authToken) {
				request.data.auth_token = this.authToken;
			}

			this.send(request);

			// Timeout after 10 seconds
			setTimeout(() => {
				if (this.pendingListens.has(nonce)) {
					this.pendingListens.delete(nonce);
					reject(new Error(`Listen timeout for topic: ${topic}`));
				}
			}, 10000);
		});
	}

	/**
	 * Send a ping to keep the connection alive
	 */
	private ping(): void {
		if (!this.isConnected || !this.ws) return;
		this.send({ type: 'PING' });
	}

	/**
	 * Start the ping loop (every 25-30 seconds)
	 */
	private startPingLoop(): void {
		this.stopPingLoop();

		const pingAndSchedule = () => {
			this.ping();

			const pongAge = (Date.now() - this.lastPong) / 1000 / 60;
			if (pongAge > 5 && this.lastPong > 0) {
				logger.warn({ pongAgeMinutes: Number(pongAge.toFixed(1)) }, 'No PONG received, reconnecting');
				this.handleReconnect();
				return;
			}

			const interval = 25000 + Math.random() * 5000;
			this.pingInterval = setTimeout(pingAndSchedule, interval);
		};

		pingAndSchedule();
	}

	private stopPingLoop(): void {
		if (this.pingInterval) {
			clearTimeout(this.pingInterval);
			this.pingInterval = null;
		}
	}

	private handleMessage(data: string): void {
		try {
			const message: PubSubMessage = JSON.parse(data);
			logger.debug({ messageType: message.type }, 'Received message');

			switch (message.type) {
				case 'PONG':
					this.lastPong = Date.now();
					break;

				case 'RESPONSE':
					this.handleResponse(message);
					break;

				case 'MESSAGE':
					this.handleDataMessage(message);
					break;

				case 'RECONNECT':
					logger.warn('Server requested reconnect');
					this.handleReconnect();
					break;

				default:
					logger.debug({ message }, 'Unknown message type');
			}
		} catch (error) {
			logger.error({ err: error }, 'Failed to parse message');
		}
	}

	/**
	 * Handle RESPONSE messages (acknowledgment of LISTEN)
	 */
	private handleResponse(message: PubSubMessage): void {
		const nonce = message.nonce;
		if (!nonce) return;

		const pending = this.pendingListens.get(nonce);
		if (!pending) return;

		this.pendingListens.delete(nonce);

		if (message.error && message.error.length > 0) {
			logger.error({ topic: pending.topic, error: message.error }, 'Listen error');
			pending.reject(new Error(message.error));
		} else {
			logger.info({ topic: pending.topic }, 'Successfully subscribed to topic');
			this.topics.push(pending.topic);
			pending.resolve();
		}
	}

	/**
	 * Handle MESSAGE type (actual event data)
	 */
	private handleDataMessage(message: PubSubMessage): void {
		if (!message.data) return;

		const { topic, message: messageStr } = message.data;

		try {
			const innerMessage = JSON.parse(messageStr);
			const messageType = innerMessage.type;

			logger.debug({ topic, messageType }, 'Topic message');

			this.onMessageHandler?.(topic, messageType, innerMessage);
		} catch (error) {
			logger.error({ err: error, topic }, 'Failed to parse inner message');
		}
	}

	private handleReconnect(): void {
		if (this.isReconnecting) return;

		this.isReconnecting = true;
		this.isConnected = false;

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.forcedClose) return;

		const delay = 30000 + Math.random() * 30000; // 30-60 seconds
		logger.warn({ delaySeconds: Math.round(delay / 1000) }, 'Reconnecting soon');

		this.reconnectTimeout = setTimeout(async () => {
			try {
				const oldTopics = [...this.topics];
				this.topics = [];

				await this.connect();

				// Re-subscribe to all topics
				for (const topic of oldTopics) {
					const requiresAuth = topic.includes('user-v1');
					try {
						await this.listen(topic, requiresAuth);
					} catch (error) {
						logger.error({ err: error, topic }, 'Failed to re-subscribe to topic');
					}
				}
			} catch (error) {
				logger.error({ err: error }, 'Reconnection failed');
				this.scheduleReconnect();
			}
		}, delay);
	}

	/**
	 * Send a message to the WebSocket
	 */
	private send(message: object): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			logger.error('Cannot send - not connected');
			return;
		}

		const str = JSON.stringify(message);
		this.ws.send(str);
	}

	private generateNonce(): string {
		return crypto.randomUUID();
	}

	isConnectedToPubSub(): boolean {
		return this.isConnected;
	}

	getTopics(): string[] {
		return [...this.topics];
	}
}

export const twitchPubSub = new TwitchPubSub();
