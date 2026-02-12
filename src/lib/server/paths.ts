import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const RUNTIME_DATA_DIR = process.env.LURK_DATA_DIR ?? join(process.cwd(), 'data');
export const AUTH_PATH = join(RUNTIME_DATA_DIR, 'auth.json');
export const CONFIG_PATH = join(RUNTIME_DATA_DIR, 'config.json');
export const DB_PATH = join(RUNTIME_DATA_DIR, 'lurk.sqlite');
export const LOG_DIR = join(process.cwd(), 'logs');

mkdirSync(RUNTIME_DATA_DIR, { recursive: true });
