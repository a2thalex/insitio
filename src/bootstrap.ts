import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { openDb } from "./db/db.js";
import { migrate } from "./db/schema.js";
import { reposRoot } from "./git/storage.js";
import type { Deps } from "./deps.js";

/** Opens the data directory and database, creating and migrating them as needed. */
export function openDeps(config: Config = loadConfig()): Deps {
  mkdirSync(reposRoot(config.dataDir), { recursive: true });
  const db = openDb(join(config.dataDir, "gitfkd.db"));
  migrate(db);
  return { db, config };
}
