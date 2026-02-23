export type ChannelPointsStatus = 'unknown' | 'enabled' | 'disabled';

export const CHANNEL_POINTS_STATUS = {
	Unknown: 'unknown',
	Enabled: 'enabled',
	Disabled: 'disabled'
} as const satisfies Record<string, ChannelPointsStatus>;

export const DEFAULT_CHANNEL_POINTS_STATUS: ChannelPointsStatus = CHANNEL_POINTS_STATUS.Unknown;
export const DEFAULT_CHANNEL_POINTS_STATUS_CHECKED_AT_MS = 0;
