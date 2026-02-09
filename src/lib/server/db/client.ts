import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';
import { getLogger } from '$lib/server/logger';

const logger = getLogger('Database');
const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'lurk.sqlite');
const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(DB_PATH, { create: true });
sqlite.run(`
	PRAGMA journal_mode = WAL;
	PRAGMA synchronous = NORMAL;
	PRAGMA foreign_keys = ON;
	PRAGMA busy_timeout = 5000;
	PRAGMA temp_store = MEMORY;
	PRAGMA cache_size = -20000;
`);

export const db = drizzle(sqlite, { schema });

let initialized = false;

export const initializeDatabase = () => {
	if (initialized) {
		return db;
	}

	migrate(db, { migrationsFolder: MIGRATIONS_DIR });
	initialized = true;
	logger.info({ path: DB_PATH, migrations: MIGRATIONS_DIR }, 'Database initialized with Drizzle migrations');
	return db;
};

export const getDatabase = () => initializeDatabase();
