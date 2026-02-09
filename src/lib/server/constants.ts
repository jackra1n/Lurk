export const PUBSUB_URL = 'wss://pubsub-edge.twitch.tv/v1';
export const GQL_URL = 'https://gql.twitch.tv/gql';
export const OAUTH_DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
export const OAUTH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export const CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa'; // Android TV client

// OAuth scopes needed for mining
export const OAUTH_SCOPES = 'channel_read chat:read user_blocks_edit user_blocks_read user_follows_edit user_read';

// User agent for Android TV client
export const USER_AGENT =
	'Mozilla/5.0 (Linux; Android 7.1; Smart Box C1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

export const GQL_OPERATIONS = {
	ClaimCommunityPoints: {
		operationName: 'ClaimCommunityPoints',
		extensions: {
			persistedQuery: {
				version: 1,
				sha256Hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0'
			}
		}
	},
	GetIDFromLogin: {
		operationName: 'GetIDFromLogin',
		extensions: {
			persistedQuery: {
				version: 1,
				sha256Hash: '94e82a7b1e3c21e186daa73ee2afc4b8f23bade1fbbff6fe8ac133f50a2f58ca'
			}
		}
	},
	ChannelPointsContext: {
		operationName: 'ChannelPointsContext',
		extensions: {
			persistedQuery: {
				version: 1,
				sha256Hash: '1530a003a7d374b0380b79db0be0534f30ff46e61cffa2bc0e2468a909fbc024'
			}
		}
	},
	VideoPlayerStreamInfoOverlayChannel: {
		operationName: 'VideoPlayerStreamInfoOverlayChannel',
		extensions: {
			persistedQuery: {
				version: 1,
				sha256Hash: 'a5f2e34d626a9f4f5c0204f910bab2194948a9502089be558bb6e779a9e1b3d2'
			}
		}
	}
} as const;

export type PubSubTopicType =
	| 'community-points-user-v1'
	| 'video-playback-by-id'
	| 'predictions-channel-v1'
	| 'raid';

export interface PubSubMessage {
	type: 'PONG' | 'RESPONSE' | 'MESSAGE' | 'RECONNECT';
	nonce?: string;
	error?: string;
	data?: {
		topic: string;
		message: string;
	};
}

export interface PubSubListenRequest {
	type: 'LISTEN';
	nonce: string;
	data: {
		topics: string[];
		auth_token?: string;
	};
}

export interface PubSubPingRequest {
	type: 'PING';
}
