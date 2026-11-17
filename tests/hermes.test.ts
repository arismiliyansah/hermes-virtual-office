// @vitest-environment node
import { HermesClient, HermesError } from "../src/hermes";
import { startMockHermes, type MockHermes } from "./mock-hermes";

let mock: MockHermes;
let client: HermesClient;

beforeEach(async () => {
  mock = await startMockHermes({ secret: "test-secret" });
  client = new HermesClient({ origin: mock.url, secret: mock.secret });
});

afterEach(async () => {
  await mock.close();
});

describe("HermesClient", () => {
  it("(a) listAgents parses the fixture returned by the gateway", async () => {
    const agents = await client.listAgents();

    expect(agents).toEqual(mock.fixtures.agents);
    expect(mock.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual(["GET /agents"]);
  });

  it("(b) signs every request with HMAC headers the mock verifies independently", async () => {
    await client.listAgents();
    await client.listTasks();
    await client.createTask("New task", "agent-2");
    await client.updateTaskStatus("task-1", "done");
    await client.sendMessage("agent-1", "hello");
    await client.listCrons();
    await client.setCronEnabled("cron-1", false);
    await client.runCron("cron-1");
    await client.a2aCall("agent-1", "agent-2", "ping");

    expect(mock.requests).toHaveLength(9);
    for (const request of mock.requests) {
      expect(request.authenticated).toBe(true);
      expect(request.headers["x-hvo-timestamp"]).toMatch(/^\d+$/);
      expect(request.headers["x-hvo-nonce"]).toMatch(/^[0-9a-f]{32}$/);
      expect(request.headers["x-hvo-signature"]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(mock.requests.map((r) => `${r.method} ${r.pathname}`)).toEqual([
      "GET /agents",
      "GET /tasks",
      "POST /tasks",
      "POST /tasks/task-1/status",
      "POST /agents/agent-1/messages",
      "GET /crons",
      "PATCH /crons/cron-1",
      "POST /crons/cron-1/run",
      "POST /a2a/call",
    ]);
  });

  it("(b) mock rejects unsigned requests and the client reports bad_response", async () => {
    const unsigned = await fetch(`${mock.url}/agents`);
    expect(unsigned.status).toBe(401);
    expect(mock.requests.at(-1)?.authenticated).toBe(false);

    const impostor = new HermesClient({ origin: mock.url, secret: "wrong-secret" });
    const error = await impostor.listAgents().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesError);
    expect((error as HermesError).code).toBe("bad_response");
    expect(mock.requests.at(-1)?.authenticated).toBe(false);
  });

  it("(c) maps HTTP 500 to HermesError(bad_response)", async () => {
    mock.failNext(500);

    const error = await client.listAgents().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesError);
    expect((error as HermesError).code).toBe("bad_response");
  });

  it("(d) maps a dropped connection to HermesError(unreachable)", async () => {
    mock.dropNext();

    const error = await client.listAgents().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HermesError);
    expect((error as HermesError).code).toBe("unreachable");
  });

  it("(e) sendMessage returns reply and sessionId", async () => {
    const result = await client.sendMessage("agent-1", "hello");

    expect(result).toEqual({ reply: "echo:hello", sessionId: "session-agent-1" });
    expect(JSON.parse(mock.requests.at(-1)?.body ?? "null")).toEqual({ text: "hello" });
  });

  it("(f) createTask sends title and owner and returns the created card", async () => {
    const card = await client.createTask("New task", "agent-2");

    expect(card).toMatchObject({ title: "New task", owner: "agent-2", status: "todo" });
    expect(JSON.parse(mock.requests.at(-1)?.body ?? "null")).toEqual({
      title: "New task",
      owner: "agent-2",
    });
  });

  it("uses an injected fetchImpl, trims the origin, and passes an abort signal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stub: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json([]);
    };
    const stubClient = new HermesClient({
      origin: "https://hermes.example.com/",
      secret: "s",
      fetchImpl: stub,
    });

    await expect(stubClient.listAgents()).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hermes.example.com/agents");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps the remaining method payloads to their provisional routes", async () => {
    const updated = await client.updateTaskStatus("task-1", "done");
    expect(updated).toMatchObject({ id: "task-1", status: "done" });
    expect(JSON.parse(mock.requests.at(-1)?.body ?? "null")).toEqual({ status: "done" });

    const cron = await client.setCronEnabled("cron-1", false);
    expect(cron).toMatchObject({ id: "cron-1", enabled: false });
    expect(JSON.parse(mock.requests.at(-1)?.body ?? "null")).toEqual({ enabled: false });

    const run = await client.runCron("cron-1");
    expect(run).toEqual({ runId: "run-cron-1" });

    const a2a = await client.a2aCall("agent-1", "agent-2", "ping");
    expect(a2a).toEqual({ ok: true });
    expect(JSON.parse(mock.requests.at(-1)?.body ?? "null")).toEqual({
      from: "agent-1",
      to: "agent-2",
      message: "ping",
    });
  });
});
