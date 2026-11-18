#!/usr/bin/env node
// Deployment preflight check. No dependencies: this must run on a fresh machine
// before `pnpm install` as well as from CI.
import { pathToFileURL } from "node:url";

export const REQUIRED_ENV = ["HERMES_ORIGIN", "SESSION_SECRET", "HVO_HMAC_SECRET"];

/**
 * Returns the names of required variables that are absent or blank.
 * `HVO_HMAC_SECRET` is the connector's name for the Worker's `HERMES_HMAC_SECRET`;
 * both sides must hold the same value, so checking the connector name catches a
 * deployment where only the Worker was configured.
 */
export function validateConfig(env = process.env) {
  return REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

export function main(argv, env = process.env) {
  if (argv.length !== 1 || argv[0] !== "--check-config") {
    console.error("usage: node scripts/smoke.mjs --check-config");
    return 2;
  }

  const missing = validateConfig(env);
  if (missing.length > 0) {
    console.error("missing required environment variables:");
    for (const name of missing) console.error(`  - ${name}`);
    return 1;
  }

  console.log("config ok");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
