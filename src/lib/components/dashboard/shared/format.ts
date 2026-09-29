const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export const formatDuration = (durationMs: number) => {
  const minutes = Math.max(0, Math.floor(durationMs / minuteMs));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
};

export const formatRelativeTime = (timestampMs: number, nowMs = Date.now()) => {
  const diffMs = Math.max(0, nowMs - timestampMs);
  if (diffMs < minuteMs) return 'just now';
  if (diffMs < hourMs) return `${Math.floor(diffMs / minuteMs)}m ago`;
  if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)}h ago`;
  return `${Math.floor(diffMs / dayMs)}d ago`;
};

export const formatExactTime = (timestampMs: number) =>
  new Date(timestampMs).toLocaleString('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

export const formatPoints = (points: number) => points.toLocaleString('en-GB');

export const formatCompactPoints = (points: number) =>
  points.toLocaleString('en-GB', { notation: 'compact', maximumFractionDigits: 1 });

// Localized display names can differ from the login entirely, so only the capitalization is taken over.
export const formatStreamerName = (streamer: { login: string; displayName: string | null }) =>
  streamer.displayName?.toLowerCase() === streamer.login ? streamer.displayName : streamer.login;
