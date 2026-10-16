import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";

export type Deps = { db: DatabaseSync; config: Config };
