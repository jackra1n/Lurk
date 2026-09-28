import { PUBSUB_URL, type PubSubMessage } from '../constants';
import { getLogger } from '../logger';
import type { PendingListen, PubSubSocketOptions } from './types';

const logger = getLogger('PubSubSocket');

const SUBSCRIPTION_RETRY_BASE_MS = 30_000;
const SUBSCRIPTION_RETRY_MAX_MS = 5 * 60_000;

interface TopicState {
  requiresAuth: boolean;
  subscribedAuth: boolean | null;
  failures: number;
  retryAtMs: number;
  error: Error | null;
  waiter: PromiseWithResolvers<void> | null;
}

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
  private connection: PromiseWithResolvers<void> | null = null;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private syncingSocket: ReturnType<PubSubSocketOptions['socketFactory']> | null = null;
  private lastPong = 0;
  private isConnected = false;
  private disposed = false;
  private topics = new Map<string, TopicState>();
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

  hasCapacity() {
    return this.topics.size < this.maxTopics;
  }

  isConnectedToPubSub() {
    return this.isConnected;
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Socket disconnected'));
    if (this.isConnected) return Promise.resolve();
    if (this.connection) return this.connection.promise;
    this.clearReconnectTimer();
    const connection = Promise.withResolvers<void>();
    this.connection = connection;
    logger.info({ socketId: this.id, url: PUBSUB_URL }, 'Connecting');
    try {
      const ws = this.socketFactory(PUBSUB_URL);
      this.ws = ws;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.isConnected = true;
        for (const state of this.topics.values()) {
          state.failures = 0;
          state.retryAtMs = 0;
          state.error = null;
        }
        this.connection = null;
        connection.resolve();
        this.lastPong = Date.now();
        this.startPingLoop();
        this.onConnectedForward(this.id);
        logger.info({ socketId: this.id }, 'Connected');
        void this.syncTopics();
      };
      ws.onmessage = (event) => {
        if (this.ws === ws) this.handleMessage(event.data);
      };
      ws.onerror = (event) => {
        if (this.ws !== ws) return;
        logger.error({ socketId: this.id, err: event }, 'WebSocket error');
        this.markDisconnected('WebSocket error');
        this.scheduleReconnect();
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.markDisconnected('Socket closed');
        this.scheduleReconnect();
      };
    } catch (error) {
      this.markDisconnected(String(error));
      this.scheduleReconnect();
    }
    return connection.promise;
  }

  disconnect() {
    this.disposed = true;
    this.clearReconnectTimer();
    this.markDisconnected('Socket disconnected');
    this.topics.clear();
  }

  /** Retain failed topics for retry; reconnects replay immediately with fresh backoff. */
  listen(topic: string, requiresAuth: boolean = false): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Socket disconnected'));
    let state = this.topics.get(topic);
    if (!state) {
      if (!this.hasCapacity()) return Promise.reject(new Error(`Socket ${this.id} reached topic capacity`));
      state = { requiresAuth, subscribedAuth: null, failures: 0, retryAtMs: 0, error: null, waiter: null };
      this.topics.set(topic, state);
    }
    state.requiresAuth ||= requiresAuth;
    if (state.subscribedAuth === state.requiresAuth) return Promise.resolve();
    if (state.error && state.retryAtMs > Date.now()) return Promise.reject(state.error);
    const waiter = (state.waiter ??= Promise.withResolvers<void>());
    if (this.isConnected) void this.syncTopics();
    else if (!this.reconnectTimeout) void this.connect().catch(() => {});
    return waiter.promise;
  }

  private async syncTopics(): Promise<void> {
    const ws = this.ws;
    if (!ws || !this.isConnected || this.syncingSocket === ws) return;
    this.syncingSocket = ws;
    clearTimeout(this.retryTimeout ?? undefined);
    this.retryTimeout = null;
    try {
      for (const [topic, state] of this.topics) {
        while (state.subscribedAuth !== state.requiresAuth && state.retryAtMs <= Date.now()) {
          if (this.ws !== ws) return;
          const requiresAuth = state.requiresAuth;
          try {
            await this.sendListen(topic, requiresAuth);
            if (this.ws !== ws) return;
            state.subscribedAuth = requiresAuth;
            state.failures = 0;
            state.retryAtMs = 0;
            state.error = null;
            if (state.subscribedAuth === state.requiresAuth) {
              state.waiter?.resolve();
              state.waiter = null;
            }
          } catch (error) {
            if (this.ws !== ws) return;
            state.failures++;
            state.retryAtMs =
              Date.now() +
              Math.min(SUBSCRIPTION_RETRY_MAX_MS, SUBSCRIPTION_RETRY_BASE_MS * 2 ** Math.min(state.failures - 1, 4));
            state.error = error instanceof Error ? error : new Error(String(error));
            state.waiter?.reject(state.error);
            state.waiter = null;
            logger.warn({ socketId: this.id, topic, err: error }, 'Subscription failed');
          }
        }
      }
    } finally {
      if (this.ws === ws) {
        this.syncingSocket = null;
        this.scheduleTopicRetry();
      }
    }
  }

  private scheduleTopicRetry() {
    let retryAtMs = Infinity;
    for (const state of this.topics.values()) {
      if (state.subscribedAuth !== state.requiresAuth) retryAtMs = Math.min(retryAtMs, state.retryAtMs);
    }
    if (Number.isFinite(retryAtMs)) {
      this.retryTimeout = setTimeout(() => void this.syncTopics(), Math.max(0, retryAtMs - Date.now()));
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

  private markDisconnected(reason: string) {
    const ws = this.ws;
    this.ws = null;
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.syncingSocket = null;
    this.stopPingLoop();
    clearTimeout(this.retryTimeout ?? undefined);
    this.retryTimeout = null;
    const error = new Error(reason);
    this.connection?.reject(error);
    this.connection = null;
    this.rejectPendingListens(reason);
    for (const state of this.topics.values()) {
      state.subscribedAuth = null;
      state.waiter?.reject(error);
      state.waiter = null;
    }
    ws?.close();
    if (wasConnected) {
      logger.info({ socketId: this.id }, 'Connection closed');
      this.onDisconnectedForward(this.id);
    }
  }

  private handleReconnect() {
    if (this.disposed) return;
    this.markDisconnected('Socket reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimeout) return;

    const [minDelay, maxDelay] = this.reconnectDelayRangeMs;
    const delay = minDelay + Math.random() * Math.max(0, maxDelay - minDelay);
    logger.warn({ socketId: this.id, delaySeconds: Math.round(delay / 1000) }, 'Reconnecting soon');

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      try {
        await this.connect();
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
