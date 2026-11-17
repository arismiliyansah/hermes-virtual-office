import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

const TIMESTAMP_TOLERANCE_S = 300;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;

export interface AgentFixture {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface TaskFixture {
  id: string;
  title: string;
  status: string;
  owner: string | null;
}

export interface CronFixture {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  agentId: string;
}

export interface Fixtures {
  agents: AgentFixture[];
  tasks: TaskFixture[];
  crons: CronFixture[];
}

export interface RecordedRequest {
  method: string;
  pathname: string;
  headers: IncomingHttpHeaders;
  body: string;
  authenticated: boolean;
}

export interface MockHermes {
  url: string;
  secret: string;
  fixtures: Fixtures;
  requests: RecordedRequest[];
  /** Answer the next authenticated requests with this HTTP status instead of a fixture. */
  failNext(status: number, count?: number): void;
  /** Destroy the socket for the next authenticated requests, simulating a dropped connection. */
  dropNext(count?: number): void;
  close(): Promise<void>;
}

type Fault = { type: "status"; status: number } | { type: "drop" };

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Mirrors the canonical form in connector/auth-proxy.mjs without importing
// src/sign.ts, so the mock independently proves the client signs correctly.
function canonicalString(
  method: string,
  pathname: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return [method, pathname, timestamp, nonce, sha256Hex(body)].join("\n");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(
  secret: string,
  req: http.IncomingMessage,
  body: string,
): boolean {
  const timestamp = headerValue(req.headers["x-hvo-timestamp"]);
  const nonce = headerValue(req.headers["x-hvo-nonce"]);
  const signature = headerValue(req.headers["x-hvo-signature"]);

  if (timestamp === undefined || !/^(0|[1-9][0-9]{0,14})$/.test(timestamp)) return false;
  if (nonce === undefined || nonce.length === 0 || nonce.length > 128) return false;
  if (signature === undefined || !SIGNATURE_HEX.test(signature)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_S) return false;

  const pathname = (req.url ?? "/").split("?")[0];
  const expected = createHmac("sha256", secret)
    .update(
      canonicalString(req.method ?? "GET", pathname, timestamp, nonce, body),
      "utf8",
    )
    .digest("hex");

  return signaturesMatch(expected, signature);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

interface RouteResult {
  status: number;
  payload: unknown;
}

function route(
  fixtures: Fixtures,
  method: string,
  pathname: string,
  rawBody: string,
): RouteResult {
  const payload = rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>);

  if (method === "GET" && pathname === "/agents") {
    return { status: 200, payload: fixtures.agents };
  }

  if (method === "GET" && pathname === "/tasks") {
    return { status: 200, payload: fixtures.tasks };
  }

  if (method === "POST" && pathname === "/tasks") {
    const task: TaskFixture = {
      id: `task-${fixtures.tasks.length + 1}`,
      title: String(payload.title),
      status: "todo",
      owner: payload.owner === null || payload.owner === undefined ? null : String(payload.owner),
    };
    fixtures.tasks.push(task);
    return { status: 201, payload: task };
  }

  const statusMatch = /^\/tasks\/([^/]+)\/status$/.exec(pathname);
  if (method === "POST" && statusMatch) {
    const id = decodeURIComponent(statusMatch[1]);
    const existing = fixtures.tasks.find((task) => task.id === id);
    const task: TaskFixture = {
      id,
      title: existing?.title ?? "unknown",
      status: String(payload.status),
      owner: existing?.owner ?? null,
    };
    fixtures.tasks = fixtures.tasks.map((item) => (item.id === id ? task : item));
    return { status: 200, payload: task };
  }

  const messageMatch = /^\/agents\/([^/]+)\/messages$/.exec(pathname);
  if (method === "POST" && messageMatch) {
    const agentId = decodeURIComponent(messageMatch[1]);
    return {
      status: 200,
      payload: { reply: `echo:${String(payload.text)}`, sessionId: `session-${agentId}` },
    };
  }

  if (method === "GET" && pathname === "/crons") {
    return { status: 200, payload: fixtures.crons };
  }

  const cronMatch = /^\/crons\/([^/]+)$/.exec(pathname);
  if (method === "PATCH" && cronMatch) {
    const id = decodeURIComponent(cronMatch[1]);
    const existing = fixtures.crons.find((cron) => cron.id === id);
    if (!existing) return { status: 404, payload: { error: "cron_not_found" } };
    const cron: CronFixture = { ...existing, enabled: Boolean(payload.enabled) };
    fixtures.crons = fixtures.crons.map((item) => (item.id === id ? cron : item));
    return { status: 200, payload: cron };
  }

  const runMatch = /^\/crons\/([^/]+)\/run$/.exec(pathname);
  if (method === "POST" && runMatch) {
    return { status: 200, payload: { runId: `run-${decodeURIComponent(runMatch[1])}` } };
  }

  if (method === "POST" && pathname === "/a2a/call") {
    return { status: 200, payload: { ok: true } };
  }

  return { status: 404, payload: { error: "not_found", method, pathname } };
}

const DEFAULT_FIXTURES: Fixtures = {
  agents: [
    { id: "agent-1", name: "Atlas", role: "coordinator", status: "desk" },
    { id: "agent-2", name: "Vega", role: "engineer", status: "meeting" },
  ],
  tasks: [{ id: "task-1", title: "Ship v1", status: "todo", owner: "agent-1" }],
  crons: [
    {
      id: "cron-1",
      name: "nightly-report",
      schedule: "0 2 * * *",
      enabled: true,
      agentId: "agent-1",
    },
  ],
};

export async function startMockHermes(
  options: { secret?: string; fixtures?: Partial<Fixtures> } = {},
): Promise<MockHermes> {
  const secret = options.secret ?? "test-secret";
  const fixtures: Fixtures = {
    agents: [...(options.fixtures?.agents ?? DEFAULT_FIXTURES.agents)],
    tasks: [...(options.fixtures?.tasks ?? DEFAULT_FIXTURES.tasks)],
    crons: [...(options.fixtures?.crons ?? DEFAULT_FIXTURES.crons)],
  };
  const requests: RecordedRequest[] = [];
  const faults: Fault[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const pathname = (req.url ?? "/").split("?")[0];
      const authenticated = verifySignature(secret, req, body);
      requests.push({
        method: req.method ?? "GET",
        pathname,
        headers: req.headers,
        body,
        authenticated,
      });

      if (!authenticated) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const fault = faults.shift();
      if (fault?.type === "drop") {
        res.destroy();
        return;
      }
      if (fault?.type === "status") {
        sendJson(res, fault.status, { error: "mock_failure", status: fault.status });
        return;
      }

      try {
        const result = route(fixtures, req.method ?? "GET", pathname, body);
        sendJson(res, result.status, result.payload);
      } catch (error) {
        sendJson(res, 500, { error: "mock_error", reason: (error as Error).message });
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock-hermes: failed to bind to a random port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    secret,
    fixtures,
    requests,
    failNext(status, count = 1) {
      for (let i = 0; i < count; i += 1) faults.push({ type: "status", status });
    },
    dropNext(count = 1) {
      for (let i = 0; i < count; i += 1) faults.push({ type: "drop" });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
