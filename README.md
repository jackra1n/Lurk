# Lurk

Lurk is a light Twitch point harvester built with Bun and Svelte.

This project is based on [Twitch-Channel-Points-Miner-v2](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2), with a stronger focus on simplicity, efficiency, and performance.

Not all features are planned to be implemented right away. The current priority is reliable channel points mining and a clean, fast analytics UI.

## Logging

Server logs use structured logging with colored terminal output and rotating files.

- Log files are written to `logs/`.
- Rotation policy is daily with the latest 14 files retained.
- Default log level is `debug` in development and `info` in production.
- Override level with `LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).

## Database

Lurk stores miner analytics in SQLite at `data/lurk.sqlite`.

- Drizzle owns schema + migration generation (`src/lib/server/db/schema.ts` + `drizzle/`).
- Migration-based schema is initialized automatically on server startup.
- Event history is append-oriented for fast timelines and visualizations.
- Schema details: `docs/database-schema.md`.
- Useful commands:
  - `bun run db:generate`
  - `bun run db:migrate`
  - `bun run db:studio`

## Notes

- Twitch APIs can change; this project remains best-effort.
