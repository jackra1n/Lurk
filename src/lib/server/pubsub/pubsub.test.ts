import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PubSubMessage } from '../constants';
import { TwitchPubSubPool } from './index';

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	static instances: FakeWebSocket[] = [];
	static failNextListen = false;

	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readyState = FakeWebSocket.CONNECTING;
	readonly listenTopics: string[] = [];
	readonly listenAuthTokens: Array<string | undefined> = [];

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.onopen?.({} as Event);
		});
	}

	send(data: string) {
		const message = JSON.parse(data) as {
			type: string;
			nonce?: string;
			data?: { topics?: string[]; auth_token?: string };
		};

		if (message.type === 'LISTEN' && message.nonce && message.data?.topics?.[0]) {
			this.listenTopics.push(message.data.topics[0]);
			this.listenAuthTokens.push(message.data.auth_token);
			queueMicrotask(() => {
				const response: PubSubMessage = {
					type: 'RESPONSE',
					nonce: message.nonce,
					error: FakeWebSocket.failNextListen ? 'listen_failed' : ''
				};
				FakeWebSocket.failNextListen = false;
				this.onmessage?.({ data: JSON.stringify(response) } as MessageEvent<string>);
			});
			return;
		}

		if (message.type === 'PING') {
			queueMicrotask(() => {
				this.onmessage?.({ data: JSON.stringify({ type: 'PONG' }) } as MessageEvent<string>);
			});
		}
	}

	close() {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({} as CloseEvent);
	}

	static reset() {
		FakeWebSocket.instances = [];
		FakeWebSocket.failNextListen = false;
	}
}

const createPubSub = (maxTopicsPerSocket = 45) =>
	new TwitchPubSubPool({
		maxTopicsPerSocket,
		reconnectDelayRangeMs: [0, 0],
		socketFactory: (url) => new FakeWebSocket(url)
	});

describe('TwitchPubSub pool', () => {
	beforeEach(() => {
		FakeWebSocket.reset();
	});

	afterEach(() => {
		FakeWebSocket.reset();
	});

	test('scales to additional sockets once socket topic capacity is reached', async () => {
		const pubsub = createPubSub(2);

		await pubsub.connect();
		await pubsub.listen('video-playback-by-id.1');
		await pubsub.listen('video-playback-by-id.2');
		await pubsub.listen('video-playback-by-id.3');

		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(pubsub.getTopics().sort()).toEqual([
			'video-playback-by-id.1',
			'video-playback-by-id.2',
			'video-playback-by-id.3'
		]);

		pubsub.disconnect();
	});

	test('does not duplicate LISTEN when the same topic is requested twice', async () => {
		const pubsub = createPubSub();

		await pubsub.connect();
		await pubsub.listen('community-points-user-v1.123', true);
		await pubsub.listen('community-points-user-v1.123', true);

		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(FakeWebSocket.instances[0].listenTopics).toEqual(['community-points-user-v1.123']);

		pubsub.disconnect();
	});

	test('passes auth token for authenticated LISTEN topics', async () => {
		const pubsub = createPubSub();

		pubsub.setAuthToken('token-abc');
		await pubsub.connect();
		await pubsub.listen('community-points-user-v1.456', true);

		expect(FakeWebSocket.instances[0].listenAuthTokens).toEqual(['token-abc']);

		pubsub.disconnect();
	});

	test('falls back to a new socket if the first socket rejects LISTEN', async () => {
		const pubsub = createPubSub();

		await pubsub.connect();
		FakeWebSocket.failNextListen = true;

		await pubsub.listen('video-playback-by-id.789');

		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(pubsub.getTopics()).toEqual(['video-playback-by-id.789']);

		pubsub.disconnect();
	});
});
