import { PUBSUB_URL, type PubSubMessage } from '../constants';
import { getLogger } from '../logger';
import type { PendingListen, PubSubSocketOptions } from './types';

const logger = getLogger('PubSubSocket');

export class PubSubSocket {
	private readonly id: number;
	private readonly maxTopics: number;
	private readonly socketFactory: PubSubSocketOptions['socketFactory'];
	private readonly getAuthToken: () => string | null;
	private readonly reconnectDelayRangeMs: readonly [number, number];
	private readonly onMessageForward: PubSubSocketOptions['onMessage'];
	private readonly onConnectedForward: PubSubSocketOptions['onConnected'];
	private readonly onDisconnectedForward: PubSubSocketOptions['onDisconnected'];

	private ws: ReturnType<PubSubSocketOptions['socketFactory']> | null = null;
	private pingInterval: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private connectPromise: Promise<void> | null = null;
	private lastPong = 0;
	private isConnected = false;
	private forcedClose = false;
	private topicAuthByName = new Map<string, boolean>();
	private subscribedTopics = new Set<string>();
	private pendingListens = new Map<string, PendingListen>();

	constructor(options: PubSubSocketOptions) {
		this.id = options.id;
		this.maxTopics = options.maxTopics;
		this.socketFactory = options.socketFactory;
		this.getAuthToken = options.getAuthToken;
		this.reconnectDelayRangeMs = options.reconnectDelayRangeMs;
		this.onMessageForward = options.onMessage;
		this.onConnectedForward = options.onConnected;
		this.onDisconnectedForward = options.onDisconnected;
	}

	getId() {
		return this.id;
	}

	getTopicCount() {
		return this.topicAuthByName.size;
	}

	hasCapacity() {
		return this.getTopicCount() < this.maxTopics;
	}

	isConnectedToPubSub() {
		return this.isConnected;
	}

	async connect() {
		if (this.isConnected) return;
		if (this.connectPromise) return this.connectPromise;

		this.forcedClose = false;

		this.connectPromise = new Promise((resolve, reject) => {
			let settled = false;
			const settle = (cb: () => void) => {
				if (settled) return;
				settled = true;
				this.connectPromise = null;
				cb();
			};

			logger.info({ socketId: this.id, url: PUBSUB_URL }, 'Connecting');
			const ws = this.socketFactory(PUBSUB_URL);
			this.ws = ws;

			ws.onopen = () => {
				this.isConnected = true;
				this.lastPong = Date.now();
				this.startPingLoop();
				this.onConnectedForward(this.id);
				logger.info({ socketId: this.id }, 'Connected');
				settle(resolve);
			};

			ws.onmessage = (event) => {
				this.handleMessage(event.data);
			};

			ws.onerror = (event) => {
				logger.error({ socketId: this.id, err: event }, 'WebSocket error');
				if (!this.isConnected) {
					settle(() => reject(new Error('Failed to connect')));
				}
			};

			ws.onclose = () => {
				const wasConnected = this.isConnected;
				this.isConnected = false;
				this.stopPingLoop();
				this.subscribedTopics.clear();
				this.rejectPendingListens('Socket closed');
				this.ws = null;

				if (wasConnected) {
					logger.info({ socketId: this.id }, 'Connection closed');
					this.onDisconnectedForward(this.id);
				}

				if (!wasConnected && !settled) {
					settle(() => reject(new Error('Socket closed before connect')));
				}

				if (!this.forcedClose) {
					this.scheduleReconnect();
				}
			};
		});

		return this.connectPromise;
	}

	disconnect() {
		this.forcedClose = true;
		this.stopPingLoop();
		this.clearReconnectTimer();
		this.rejectPendingListens('Socket disconnected');

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.isConnected = false;
		this.connectPromise = null;
		this.topicAuthByName.clear();
		this.subscribedTopics.clear();
	}

	async listen(topic: string, requiresAuth: boolean = false) {
		const existingRequiresAuth = this.topicAuthByName.get(topic) === true;
		const nextRequiresAuth = existingRequiresAuth || requiresAuth;
		const wasKnownTopic = this.topicAuthByName.has(topic);

		if (!wasKnownTopic && !this.hasCapacity()) {
			throw new Error(`Socket ${this.id} reached topic capacity`);
		}

		this.topicAuthByName.set(topic, nextRequiresAuth);

		if (this.subscribedTopics.has(topic)) return;

		try {
			await this.sendListen(topic, nextRequiresAuth);
			this.subscribedTopics.add(topic);
		} catch (error) {
			if (!wasKnownTopic) {
				this.topicAuthByName.delete(topic);
			}
			this.subscribedTopics.delete(topic);
			throw error;
		}
	}

	private async replayTopics() {
		if (this.topicAuthByName.size === 0) return;

		for (const [topic, requiresAuth] of this.topicAuthByName.entries()) {
			try {
				await this.sendListen(topic, requiresAuth);
				this.subscribedTopics.add(topic);
				logger.info({ socketId: this.id, topic }, 'Re-subscribed to topic');
			} catch (error) {
				logger.error({ socketId: this.id, topic, err: error }, 'Failed to re-subscribe to topic');
			}
		}
	}

	private async sendListen(topic: string, requiresAuth: boolean) {
		if (!this.isConnected || !this.ws) {
			throw new Error('Not connected to PubSub');
		}

		return new Promise<void>((resolve, reject) => {
			const nonce = this.generateNonce();
			const timeout = setTimeout(() => {
				const pending = this.pendingListens.get(nonce);
				if (!pending) return;
				this.pendingListens.delete(nonce);
				pending.reject(new Error(`Listen timeout for topic: ${pending.topic}`));
			}, 10_000);

			this.pendingListens.set(nonce, {
				topic,
				resolve: () => {
					clearTimeout(timeout);
					resolve();
				},
				reject: (error: Error) => {
					clearTimeout(timeout);
					reject(error);
				},
				timeout
			});

			const request: { type: string; nonce: string; data: { topics: string[]; auth_token?: string } } = {
				type: 'LISTEN',
				nonce,
				data: {
					topics: [topic]
				}
			};

			if (requiresAuth) {
				const authToken = this.getAuthToken();
				if (authToken) {
					request.data.auth_token = authToken;
				}
			}

			try {
				this.send(request);
			} catch (error) {
				const pending = this.pendingListens.get(nonce);
				if (pending) {
					this.pendingListens.delete(nonce);
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
	}

	private ping() {
		if (!this.isConnected || !this.ws) return;
		try {
			this.send({ type: 'PING' });
		} catch (error) {
			logger.error({ socketId: this.id, err: error }, 'Failed to send ping');
		}
	}

	private startPingLoop() {
		this.stopPingLoop();

		const pingAndSchedule = () => {
			this.ping();

			const pongAge = (Date.now() - this.lastPong) / 1000 / 60;
			if (pongAge > 5 && this.lastPong > 0) {
				logger.warn({ socketId: this.id, pongAgeMinutes: Number(pongAge.toFixed(1)) }, 'No PONG received');
				this.handleReconnect();
				return;
			}

			const interval = 25_000 + Math.random() * 5_000;
			this.pingInterval = setTimeout(pingAndSchedule, interval);
		};

		pingAndSchedule();
	}

	private stopPingLoop() {
		if (!this.pingInterval) return;
		clearTimeout(this.pingInterval);
		this.pingInterval = null;
	}

	private handleMessage(data: string) {
		try {
			const message: PubSubMessage = JSON.parse(data);

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
					logger.warn({ socketId: this.id }, 'Server requested reconnect');
					this.handleReconnect();
					break;
				default:
					logger.debug({ socketId: this.id, message }, 'Unknown message type');
			}
		} catch (error) {
			logger.error({ socketId: this.id, err: error }, 'Failed to parse message');
		}
	}

	private handleResponse(message: PubSubMessage) {
		const nonce = message.nonce;
		if (!nonce) return;

		const pending = this.pendingListens.get(nonce);
		if (!pending) return;

		this.pendingListens.delete(nonce);

		if (message.error && message.error.length > 0) {
			pending.reject(new Error(message.error));
			return;
		}

		pending.resolve();
	}

	private handleDataMessage(message: PubSubMessage) {
		if (!message.data) return;
		const { topic, message: messageStr } = message.data;

		try {
			const innerMessage = JSON.parse(messageStr);
			const messageType = innerMessage.type;
			this.onMessageForward(topic, messageType, innerMessage);
		} catch (error) {
			logger.error({ socketId: this.id, err: error, topic }, 'Failed to parse inner message');
		}
	}

	private handleReconnect() {
		if (this.forcedClose) return;
		this.isConnected = false;
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.scheduleReconnect();
	}

	private scheduleReconnect() {
		if (this.forcedClose || this.reconnectTimeout) return;

		const [minDelay, maxDelay] = this.reconnectDelayRangeMs;
		const delay = minDelay + Math.random() * Math.max(0, maxDelay - minDelay);
		logger.warn({ socketId: this.id, delaySeconds: Math.round(delay / 1000) }, 'Reconnecting soon');

		this.reconnectTimeout = setTimeout(async () => {
			this.reconnectTimeout = null;

			try {
				await this.connect();
				await this.replayTopics();
			} catch (error) {
				logger.error({ socketId: this.id, err: error }, 'Reconnection failed');
				this.scheduleReconnect();
			}
		}, delay);
	}

	private clearReconnectTimer() {
		if (!this.reconnectTimeout) return;
		clearTimeout(this.reconnectTimeout);
		this.reconnectTimeout = null;
	}

	private rejectPendingListens(reason: string) {
		for (const [nonce, pending] of this.pendingListens.entries()) {
			this.pendingListens.delete(nonce);
			clearTimeout(pending.timeout);
			pending.reject(new Error(reason));
		}
	}

	private send(message: object) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Cannot send - not connected');
		}

		this.ws.send(JSON.stringify(message));
	}

	private generateNonce() {
		return crypto.randomUUID();
	}
}
