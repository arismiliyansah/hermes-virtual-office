import { applyD1Migrations } from "cloudflare:test";
// @ts-expect-error Vite inlines ?raw imports; this project has no ambient declaration for them.
import initSql from "../migrations/0001_init.sql?raw";
// @ts-expect-error Vite inlines ?raw imports; this project has no ambient declaration for them.
import taskStatusesSql from "../migrations/0002_task_statuses.sql?raw";
// @ts-expect-error Vite inlines ?raw imports; this project has no ambient declaration for them.
import seedStatusesSql from "../migrations/0003_seed_statuses.sql?raw";

export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((query) => query.trim())
    .filter(Boolean);
}

/** Every migration the Worker deploys, so tests never run a partial schema. */
export const MIGRATIONS = [
  { name: "0001_init.sql", queries: splitSql(initSql) },
  { name: "0002_task_statuses.sql", queries: splitSql(taskStatusesSql) },
  { name: "0003_seed_statuses.sql", queries: splitSql(seedStatusesSql) },
] as const;

export async function applyAllMigrations(db: D1Database): Promise<void> {
  await applyD1Migrations(db, [...MIGRATIONS]);
}
