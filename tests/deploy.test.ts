// @vitest-environment node
// scripts/smoke.mjs runs as a plain Node process: workerd has no child_process,
// so this file belongs to the "node" project in vitest.config.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = path.join(ROOT, "scripts", "smoke.mjs");

interface RunResult {
  status: number | null;
  output: string;
}

function runCheckConfig(env: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, [SMOKE, "--check-config"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const COMPLETE = {
  HERMES_ORIGIN: "https://hermes-office.example.com",
  SESSION_SECRET: "session-secret",
  HVO_HMAC_SECRET: "hmac-secret",
};

describe("scripts/smoke.mjs --check-config", () => {
  it("fails with exit 1 and names every missing variable when env is empty", () => {
    const result = runCheckConfig({});

    expect(result.status).toBe(1);
    expect(result.output).toContain("HERMES_ORIGIN");
    expect(result.output).toContain("SESSION_SECRET");
    expect(result.output).toContain("HVO_HMAC_SECRET");
  });

  it("names only the variable that is missing", () => {
    const { SESSION_SECRET: _omitted, ...partial } = COMPLETE;

    const result = runCheckConfig(partial);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_SECRET");
    expect(result.output).not.toContain("HVO_HMAC_SECRET");
    expect(result.output).not.toContain("HERMES_ORIGIN");
  });

  it("exits 0 when the required env is complete", () => {
    const result = runCheckConfig(COMPLETE);

    expect(result.status).toBe(0);
    expect(result.output).toContain("config ok");
  });

  it("treats whitespace-only values as missing", () => {
    const result = runCheckConfig({ ...COMPLETE, HERMES_ORIGIN: "   " });

    expect(result.status).toBe(1);
    expect(result.output).toContain("HERMES_ORIGIN");
  });
});

describe(".gitignore", () => {
  it("ignores local secret files", () => {
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");

    expect(ignore).toMatch(/^\.dev\.vars\*$/m);
    expect(ignore).toMatch(/^\.env\*$/m);
  });
});
