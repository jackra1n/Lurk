import { getLogger } from '../logger';
import { PubSubSocket } from './socket';
import type { MessageHandler, TwitchPubSubOptions } from './types';

const logger = getLogger('PubSubPool');

const DEFAULT_MAX_TOPICS_PER_SOCKET = 45;
const DEFAULT_RECONNECT_DELAY_RANGE_MS: readonly [number, number] = [30_000, 60_000];
const SUBSCRIPTION_RETRY_BASE_MS = 30_000;
const SUBSCRIPTION_RETRY_MAX_MS = 5 * 60_000;

interface DesiredSubscription {
  requiresAuth: boolean;
  failures: number;
  retryAtMs: number;
  error: Error | null;
  pending: Promise<void> | null;
}

export class TwitchPubSubPool {
  private readonly maxTopicsPerSocket: number;
  private readonly reconnectDelayRangeMs: readonly [number, number];
  private readonly socketFactory: NonNullable<TwitchPubSubOptions['socketFactory']>;
  private authToken: string | null = null;

  private sockets = new Map<number, PubSubSocket>();
  private topicToSocketId = new Map<string, number>();
  private connectedSocketIds = new Set<number>();
  private nextSocketId = 1;
  private desiredSubscriptions = new Map<string, DesiredSubscription>();
  private subscriptionRetryInterval: NodeJS.Timeout | undefined;
  private subscriptionRetry: Promise<void> | null = null;
  private generation = 0;

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
    this.generation++;
    clearInterval(this.subscriptionRetryInterval);
    this.subscriptionRetryInterval = undefined;
    this.subscriptionRetry = null;
    this.desiredSubscriptions.clear();
    for (const socket of this.sockets.values()) {
      socket.disconnect();
    }

    this.sockets.clear();
    this.topicToSocketId.clear();
    this.connectedSocketIds.clear();
    this.nextSocketId = 1;
  }

  /** Failed attempts retain subscription intent until disconnect. */
  listen(topic: string, requiresAuth: boolean = false): Promise<void> {
    let desired = this.desiredSubscriptions.get(topic);
    if (!desired) {
      desired = { requiresAuth, failures: 0, retryAtMs: 0, error: null, pending: null };
      this.desiredSubscriptions.set(topic, desired);
    } else {
      desired.requiresAuth ||= requiresAuth;
    }
    if (!this.subscriptionRetryInterval) {
      this.subscriptionRetryInterval = setInterval(() => this.retryMissingSubscriptions(), 1_000);
    }
    return this.subscribe(topic, desired);
  }

  private subscribe(topic: string, desired: DesiredSubscription): Promise<void> {
    if (desired.pending) return desired.pending;
    if (desired.error && Date.now() < desired.retryAtMs) return Promise.reject(desired.error);
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(async () => {
        this.assertGeneration(generation);
        const socketId = this.topicToSocketId.get(topic);
        const socket = socketId === undefined ? undefined : this.sockets.get(socketId);
        if (socket) {
          await socket.listen(topic, desired.requiresAuth);
        } else {
          await this.tryListenWithFallback(topic, desired.requiresAuth, generation);
        }
        this.assertGeneration(generation);
        desired.failures = 0;
        desired.retryAtMs = 0;
        desired.error = null;
      })
      .catch((error: unknown) => {
        if (generation === this.generation) {
          desired.failures++;
          desired.retryAtMs =
            Date.now() +
            Math.min(SUBSCRIPTION_RETRY_MAX_MS, SUBSCRIPTION_RETRY_BASE_MS * 2 ** Math.min(desired.failures - 1, 4));
          desired.error = error instanceof Error ? error : new Error(String(error));
        }
        throw error;
      })
      .finally(() => {
        desired.pending = null;
      });
    desired.pending = pending;
    return pending;
  }

  private retryMissingSubscriptions(): void {
    if (this.subscriptionRetry || !this.isConnectedToPubSub()) return;
    const now = Date.now();
    let next: [string, DesiredSubscription] | undefined;
    for (const entry of this.desiredSubscriptions) {
      const [topic, desired] = entry;
      if (desired.pending || desired.retryAtMs > now) continue;
      const socketId = this.topicToSocketId.get(topic);
      const socket = socketId === undefined ? undefined : this.sockets.get(socketId);
      if (socket && (!socket.isConnectedToPubSub() || socket.isSubscribed(topic, desired.requiresAuth))) continue;
      if (!next || desired.retryAtMs < next[1].retryAtMs) next = entry;
    }
    if (!next) return;
    const [topic, desired] = next;
    const generation = this.generation;
    const retry = this.subscribe(topic, desired)
      .catch((error: unknown) => {
        if (generation === this.generation) {
          logger.warn({ topic, retryAtMs: desired.retryAtMs, err: error }, 'Subscription retry failed');
        }
      })
      .finally(() => {
        if (this.subscriptionRetry === retry) this.subscriptionRetry = null;
      });
    this.subscriptionRetry = retry;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('PubSub subscription interrupted by disconnect');
  }

  isConnectedToPubSub() {
    return this.connectedSocketIds.size > 0;
  }

  getTopics() {
    return Array.from(this.topicToSocketId.keys());
  }

  private async tryListenWithFallback(topic: string, requiresAuth: boolean, generation: number) {
    const attemptedSocketIds = new Set<number>();
    const firstSocket = await this.getOrCreateSocketWithCapacity(generation);
    this.assertGeneration(generation);
    attemptedSocketIds.add(firstSocket.getId());

    try {
      await firstSocket.listen(topic, requiresAuth);
      this.assertGeneration(generation);
      this.topicToSocketId.set(topic, firstSocket.getId());
      logger.info({ socketId: firstSocket.getId(), topic }, 'Subscribed to topic');
      return;
    } catch (error) {
      logger.warn({ socketId: firstSocket.getId(), topic, err: error }, 'Listen failed on primary socket');
    }

    this.assertGeneration(generation);
    const fallbackSocket = await this.getOrCreateSocketWithCapacity(generation, attemptedSocketIds);
    this.assertGeneration(generation);

    try {
      await fallbackSocket.listen(topic, requiresAuth);
      this.assertGeneration(generation);
      this.topicToSocketId.set(topic, fallbackSocket.getId());
      logger.info({ socketId: fallbackSocket.getId(), topic }, 'Subscribed to topic (fallback)');
    } catch (error) {
      throw new Error(`Failed to subscribe topic after fallback: ${topic} (${String(error)})`, { cause: error });
    }
  }

  private async getOrCreateSocketWithCapacity(generation: number, exclude = new Set<number>()) {
    this.assertGeneration(generation);
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
      this.assertGeneration(generation);
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
