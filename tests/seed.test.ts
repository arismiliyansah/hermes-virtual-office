// @vitest-environment node
// scripts/seed.sh is a plain shell script; workerd cannot spawn processes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "seed.sh");

interface RunResult {
  status: number | null;
  output: string;
  pnpmArgs: string[];
}

let tempDir: string;
let logPath: string;

function fakePnpm(): string {
  const binDir = path.join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, "pnpm");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${logPath}"\nexit 0\n`,
    { mode: 0o755 },
  );
  return binDir;
}

function runSeed(args: string[]): RunResult {
  const binDir = fakePnpm();
  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    encoding: "utf8",
  });

  const pnpmArgs = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
    : [];

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    pnpmArgs,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "hermes-seed-"));
  logPath = path.join(tempDir, "pnpm.log");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("scripts/seed.sh", () => {
  it("refuses a remote seed while the default password hash is checked in", () => {
    const result = runSeed(["--remote"]);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/default development password hash/i);
    expect(result.output).toContain("--allow-dev-password");
    expect(result.pnpmArgs).toEqual([]);
  });

  it("allows a remote seed with --allow-dev-password", () => {
    const result = runSeed(["--remote", "--allow-dev-password"]);

    expect(result.status).toBe(0);
    expect(result.pnpmArgs).toEqual([
      "exec",
      "wrangler",
      "d1",
      "execute",
      "hermes-office",
      "--remote",
      "--file=scripts/seed.sql",
    ]);
  });

  it("keeps local seeding unguarded", () => {
    const result = runSeed([]);

    expect(result.status).toBe(0);
    expect(result.pnpmArgs).toContain("--local");
  });

  it("rejects unknown flags with exit 2", () => {
    const result = runSeed(["--production"]);

    expect(result.status).toBe(2);
    expect(result.pnpmArgs).toEqual([]);
  });
});
