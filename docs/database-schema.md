# Database Schema (SQLite)

Lurk uses an append-first SQLite schema focused on fast timeline queries and future analytics.

- Runtime: SQLite (`bun:sqlite`) with Drizzle ORM
- Source of truth: `src/lib/server/db/schema.ts`
- Migrations: generated into `drizzle/` with Drizzle Kit

## Design goals

- Fast writes for frequent events (`WAL`, `synchronous=NORMAL`).
- Enough context for rich visualizations (balances, reasons, stream sessions, metadata).
- Backward-compatible growth via migrations.

## Workflow

- `bun run db:generate` to generate SQL migrations from schema changes.
- `bun run db:migrate` to apply pending migrations.
- `bun run db:studio` for local DB inspection.

## Core tables

### `streamers`

Canonical channel identity used by all event tables.

- `id` primary key
- `login` (nullable)
- `channel_id` (nullable)
- `display_name` (optional)
- `created_at_ms`, `updated_at_ms`

At least one of `login` or `channel_id` is required.

### `miner_runs`

One row per miner lifecycle run.

- `started_at_ms`, `stopped_at_ms`
- `start_reason`, `stop_reason`
- `user_id`, `username`

### `stream_sessions`

Represents one live stream window per streamer.

- `streamer_id`
- `broadcast_id`
- `title`, `game_name`
- `started_at_ms`, `ended_at_ms`

### `channel_point_events`

Primary append-only event ledger.

- `occurred_at_ms` (timeline axis)
- `streamer_id`
- `miner_run_id`, `stream_session_id`
- `event_type` (`points_earned`, `claim_success`, `stream_up`, `minute_watched_tick`, etc.)
- `source` (`pubsub`, `gql_context`, `gql_stream`, `spade`)
- `reason_code` (e.g. `WATCH`, `CLAIM`, `WATCH_STREAK`)
- `points_delta`
- `balance_after`
- `claim_id`
- `broadcast_id`, `viewers_count`
- `payload_json` (optional raw payload)

### `balance_samples`

Dense balance timeline optimized for graphs.

- `streamer_id`
- `sampled_at_ms`
- `balance`
- `source_event_id`

`balance_samples` is auto-populated when an event has `balance_after`.

## Useful timeline query

```sql
SELECT
	e.occurred_at_ms AS ts,
	e.balance_after AS balance,
	COALESCE(e.reason_code, e.event_type) AS label
FROM channel_point_events e
JOIN streamers s ON s.id = e.streamer_id
WHERE s.login = ?1
  AND e.balance_after IS NOT NULL
ORDER BY e.occurred_at_ms;
```
