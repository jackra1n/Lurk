# Lurk

Lurk is a light Twitch point harvester built with Bun and Svelte.

This project is based on [Twitch-Channel-Points-Miner-v2](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2), with a stronger focus on simplicity, efficiency, and performance.

Not all features are planned to be implemented right away. The current priority is reliable channel points mining and a clean, fast analytics UI.

## Logging

Server logs use structured logging with colored terminal output and rotating files.

- Log files are written to `./logs/`.
- Rotation policy is daily with the latest 14 files retained.
- Default log level is `debug` in development and `info` in production.
- Override level with `LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).

## Database

Lurk stores miner analytics in SQLite at `<LURK_DATA_DIR>/lurk.sqlite` (default: `./data/lurk.sqlite`).

- Drizzle owns schema + migration generation (`src/lib/server/db/schema.ts` + `drizzle/`).
- Migration-based schema is initialized automatically on server startup.
- Event history is append-oriented for fast timelines and visualizations.
- Schema details: `docs/database-schema.md`.
- Useful commands:
  - `bun run db:generate`
  - `bun run db:migrate`
  - `bun run db:studio`

## Config

Runtime state files live under `<LURK_DATA_DIR>` (default: `./data`):

- `config.json`
- `auth.json`
- `lurk.sqlite`

Runtime config is `<LURK_DATA_DIR>/config.json`.
Use `example.config.json` as the starting template:

```bash
mkdir -p data
cp example.config.json data/config.json
```

- `streamers`: channels to monitor.
- `autoStartMiner`: when `false`, miner startup is skipped on app boot. Manual start via API/UI still works.

## Docker Compose (Example)

Start from `compose.example.yaml`:

```bash
cp compose.example.yaml compose.yaml
docker compose up -d
```

## Notes

- Twitch APIs can change; this project remains best-effort.
