# Lurk

## What Lurk Is

Lurk is a lightweight Twitch channel points miner with a web UI.

It is built with Bun + SvelteKit, with an emphasis on efficient runtime behavior and a clear analytics UI.
This project is inspired by [Twitch-Channel-Points-Miner-v2](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2).

## Configuration

Set your tracked streamers in `data/config.json` before starting Lurk.

```bash
mkdir -p data
cp example.config.json data/config.json
```

Example:

```json
{
  "streamers": [
    "streamer1",
    "streamer2",
    "streamer3"
  ],
  "autoStartMiner": true
}
```

- `streamers`: Twitch streamers to track.
- `autoStartMiner`: if `true`, miner tries to start automatically on boot.

## Quick Start

```bash
mkdir -p logs
cp example.compose.yaml compose.yaml
docker compose up -d
```

Open `http://localhost:3000`.

The example compose file persists:
- `./data` -> `/data` (runtime state and SQLite database)
- `./logs` -> `/app/logs` (server logs)

## First-Run Setup in the UI

1. Open the app in your browser.
2. Start Twitch login from the UI (device flow) and complete verification.
3. The miner should start automatically after authentication.

## Data and Runtime Files

`<LURK_DATA_DIR>` defaults to `./data` locally and `/data` in the provided container image.

- `<LURK_DATA_DIR>/config.json`: runtime config you edit.
- `<LURK_DATA_DIR>/auth.json`: stored auth/session state (managed by app).
- `<LURK_DATA_DIR>/lurk.sqlite`: analytics database (managed by app).
- `./logs/`: rotating server logs.

If you back up one thing, back up your data directory.

## Deploy and Operate Notes

Environment variables:
- `LURK_DATA_DIR`: runtime state directory.
- `LOG_LEVEL`: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.
- `PORT`: HTTP port (default `3000` in container runtime).
- `HOST`: bind host (default `0.0.0.0` in container runtime).

Health endpoint: `GET /api/health`

## Development

This section is for contributors and local development workflows.

- Database schema docs: `docs/database-schema.md`
- DB commands:
  - `bun run db:generate`
  - `bun run db:migrate`
  - `bun run db:studio`

## Notes

- Twitch APIs can change. Lurk remains best-effort.
