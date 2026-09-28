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
    const socket = this.findConnectedSocket() ?? this.sockets.values().next().value ?? this.createSocket();
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

  listen(topic: string, requiresAuth: boolean = false): void {
    const socketId = this.topicToSocketId.get(topic);
    let socket = socketId === undefined ? undefined : this.sockets.get(socketId);
    if (!socket) {
      socket = this.findSocketWithCapacity() ?? this.createSocket();
      this.topicToSocketId.set(topic, socket.getId());
    }
    socket.listen(topic, requiresAuth);
  }

  isConnectedToPubSub() {
    return this.connectedSocketIds.size > 0;
  }

  /** Assigned topics, including those awaiting acknowledgement or retry. */
  getTopics() {
    return Array.from(this.topicToSocketId.keys());
  }

  private findSocketWithCapacity() {
    let available: PubSubSocket | undefined;
    for (const socket of this.sockets.values()) {
      if (!socket.hasCapacity()) continue;
      if (socket.isConnectedToPubSub()) return socket;
      available ??= socket;
    }
    return available;
  }

  private findConnectedSocket() {
    for (const socket of this.sockets.values()) {
      if (socket.isConnectedToPubSub()) return socket;
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
