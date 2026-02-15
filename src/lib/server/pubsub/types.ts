export type MessageHandler = (topic: string, messageType: string, data: unknown) => void;

export interface PendingListen {
	topic: string;
	resolve: () => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export interface PubSubSocketTransport {
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent<string>) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface PubSubSocketOptions {
	id: number;
	maxTopics: number;
	socketFactory: (url: string) => PubSubSocketTransport;
	getAuthToken: () => string | null;
	reconnectDelayRangeMs: readonly [number, number];
	onMessage: MessageHandler;
	onConnected: (socketId: number) => void;
	onDisconnected: (socketId: number) => void;
}

export interface TwitchPubSubOptions {
	maxTopicsPerSocket?: number;
	reconnectDelayRangeMs?: readonly [number, number];
	socketFactory?: (url: string) => PubSubSocketTransport;
}
