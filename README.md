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
