import { getLogger } from '../logger';
import { PubSubSocket } from './socket';
import type { MessageHandler, TwitchPubSubOptions } from './types';

const logger = getLogger('PubSubPool');

const DEFAULT_MAX_TOPICS_PER_SOCKET = 45;
const DEFAULT_RECONNECT_DELAY_RANGE_MS: readonly [number, number] = [30_000, 60_000];

export class TwitchPubSubPool {
	private readonly maxTopicsPerSocket: number;
	private readonly reconnectDelayRangeMs: readonly [number, number];
	private readonly socketFactory: NonNullable<TwitchPubSubOptions['socketFactory']>;
	private authToken: string | null = null;

	private sockets = new Map<number, PubSubSocket>();
	private topicToSocketId = new Map<string, number>();
	private connectedSocketIds = new Set<number>();
	private nextSocketId = 1;

	private onMessageHandler: MessageHandler | null = null;
	private onConnectedHandler: (() => void) | null = null;
	private onDisconnectedHandler: (() => void) | null = null;

	constructor(options: TwitchPubSubOptions = {}) {
		this.maxTopicsPerSocket = options.maxTopicsPerSocket ?? DEFAULT_MAX_TOPICS_PER_SOCKET;
		this.reconnectDelayRangeMs = options.reconnectDelayRangeMs ?? DEFAULT_RECONNECT_DELAY_RANGE_MS;
		this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
	}

	setAuthToken(token: string) {
		this.authToken = token;
	}

	onMessage(handler: MessageHandler) {
		this.onMessageHandler = handler;
	}

	onConnected(handler: () => void) {
		this.onConnectedHandler = handler;
	}

	onDisconnected(handler: () => void) {
		this.onDisconnectedHandler = handler;
	}

	async connect() {
		const socket = this.findConnectedSocket() ?? this.findAnySocket() ?? this.createSocket();
		await socket.connect();
	}

	disconnect() {
		for (const socket of this.sockets.values()) {
			socket.disconnect();
		}

		this.sockets.clear();
		this.topicToSocketId.clear();
		this.connectedSocketIds.clear();
		this.nextSocketId = 1;
	}

	async listen(topic: string, requiresAuth: boolean = false) {
		const existingSocketId = this.topicToSocketId.get(topic);
		const existingSocket = existingSocketId ? this.sockets.get(existingSocketId) : undefined;
		if (existingSocket) {
			try {
				await existingSocket.listen(topic, requiresAuth);
				return;
			} catch (error) {
				logger.warn(
					{ socketId: existingSocketId, topic, err: error },
					'Assigned socket listen failed, retrying assignment'
				);
				this.topicToSocketId.delete(topic);
			}
		}

		await this.tryListenWithFallback(topic, requiresAuth);
	}

	isConnectedToPubSub() {
		return this.connectedSocketIds.size > 0;
	}

	getTopics() {
		return Array.from(this.topicToSocketId.keys());
	}

	private async tryListenWithFallback(topic: string, requiresAuth: boolean) {
		const attemptedSocketIds = new Set<number>();
		const firstSocket = await this.getOrCreateSocketWithCapacity();
		attemptedSocketIds.add(firstSocket.getId());

		try {
			await firstSocket.listen(topic, requiresAuth);
			this.topicToSocketId.set(topic, firstSocket.getId());
			logger.info({ socketId: firstSocket.getId(), topic }, 'Subscribed to topic');
			return;
		} catch (error) {
			logger.warn({ socketId: firstSocket.getId(), topic, err: error }, 'Listen failed on primary socket');
		}

		const fallbackSocket = await this.getOrCreateSocketWithCapacity(attemptedSocketIds);

		try {
			await fallbackSocket.listen(topic, requiresAuth);
			this.topicToSocketId.set(topic, fallbackSocket.getId());
			logger.info({ socketId: fallbackSocket.getId(), topic }, 'Subscribed to topic (fallback)');
		} catch (error) {
			throw new Error(`Failed to subscribe topic after fallback: ${topic} (${String(error)})`);
		}
	}

	private async getOrCreateSocketWithCapacity(exclude = new Set<number>()) {
		for (const socket of this.sockets.values()) {
			if (exclude.has(socket.getId())) continue;
			if (!socket.hasCapacity()) continue;
			if (!socket.isConnectedToPubSub()) continue;
			return socket;
		}

		for (const socket of this.sockets.values()) {
			if (exclude.has(socket.getId())) continue;
			if (!socket.hasCapacity()) continue;
			try {
				await socket.connect();
				return socket;
			} catch (error) {
				logger.error({ socketId: socket.getId(), err: error }, 'Failed to connect existing socket');
			}
		}

		const socket = this.createSocket();
		await socket.connect();
		return socket;
	}

	private findConnectedSocket() {
		for (const socket of this.sockets.values()) {
			if (socket.isConnectedToPubSub()) return socket;
		}
	}

	private findAnySocket() {
		for (const socket of this.sockets.values()) {
			return socket;
		}
	}

	private createSocket() {
		const socketId = this.nextSocketId++;
		const socket = new PubSubSocket({
			id: socketId,
			maxTopics: this.maxTopicsPerSocket,
			socketFactory: this.socketFactory,
			getAuthToken: () => this.authToken,
			reconnectDelayRangeMs: this.reconnectDelayRangeMs,
			onMessage: (topic, messageType, data) => {
				this.onMessageHandler?.(topic, messageType, data);
			},
			onConnected: (id) => this.handleSocketConnected(id),
			onDisconnected: (id) => this.handleSocketDisconnected(id)
		});

		this.sockets.set(socketId, socket);
		logger.info({ socketId }, 'Created PubSub socket');
		return socket;
	}

	private handleSocketConnected(socketId: number) {
		const previousCount = this.connectedSocketIds.size;
		this.connectedSocketIds.add(socketId);

		if (previousCount === 0 && this.connectedSocketIds.size > 0) {
			this.onConnectedHandler?.();
		}
	}

	private handleSocketDisconnected(socketId: number) {
		const previousCount = this.connectedSocketIds.size;
		this.connectedSocketIds.delete(socketId);

		if (previousCount > 0 && this.connectedSocketIds.size === 0) {
			this.onDisconnectedHandler?.();
		}
	}
}

export const twitchPubSubPool = new TwitchPubSubPool();
