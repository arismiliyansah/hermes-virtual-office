import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, createSession } from "../src/auth";
import type { ServerMsg } from "../src/protocol";

const bindings = env as unknown as {
  OFFICE_HUB: DurableObjectNamespace;
  SESSION_SECRET: string;
};

function hub() {
  return bindings.OFFICE_HUB.get(bindings.OFFICE_HUB.idFromName("main"));
}

function broadcast(msg: ServerMsg): Promise<Response> {
  return hub().fetch("https://office-hub.internal/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
}

function nextFrame(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for a websocket frame"));
    }, timeoutMs);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data as string);
      },
      { once: true },
    );
  });
}

function parse(frame: string): ServerMsg {
  return JSON.parse(frame) as ServerMsg;
}

function expectSnapshot(msg: ServerMsg) {
  expect(msg.type).toBe("snapshot");
  if (msg.type !== "snapshot") throw new Error("expected a snapshot message");
  return msg.payload;
}

async function connect(): Promise<{ ws: WebSocket; snapshot: Promise<string> }> {
  const token = await createSession("owner-1", bindings.SESSION_SECRET);
  const res = await SELF.fetch("http://localhost/api/ws", {
    headers: {
      Upgrade: "websocket",
      Cookie: `${SESSION_COOKIE}=${token}`,
    },
  });
  expect(res.status).toBe(101);

  const ws = res.webSocket;
  if (ws === null) throw new Error("expected a websocket on the upgrade");

  ws.accept();
  return { ws, snapshot: nextFrame(ws) };
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.addEventListener("close", () => resolve(), { once: true });
  });
}

describe("OfficeHub", () => {
  it("broadcasts agent_state to every connected client", async () => {
    const a = await connect();
    const b = await connect();
    parse(await a.snapshot);
    parse(await b.snapshot);

    const frameA = nextFrame(a.ws);
    const frameB = nextFrame(b.ws);
    const res = await broadcast({
      type: "agent_state",
      payload: { agentId: "agent-a", duty: "desk" },
    });
    expect(res.status).toBe(204);

    const [rawA, rawB] = await Promise.all([frameA, frameB]);
    expect(rawB).toBe(rawA);
    expect(parse(rawA)).toEqual({
      type: "agent_state",
      payload: { agentId: "agent-a", duty: "desk" },
    });

    a.ws.close();
    b.ws.close();
  });

  it("sends the latest snapshot to a new client", async () => {
    const a = await connect();
    parse(await a.snapshot);

    const res = await broadcast({
      type: "agent_state",
      payload: { agentId: "agent-b", duty: "meeting" },
    });
    expect(res.status).toBe(204);

    const late = await connect();
    const payload = expectSnapshot(parse(await late.snapshot));
    expect(payload.agents).toContainEqual({ id: "agent-b", duty: "meeting" });

    a.ws.close();
    late.ws.close();
  });

  it("keeps broadcasting after a client disconnects", async () => {
    const a = await connect();
    parse(await a.snapshot);

    const closed = waitForClose(a.ws);
    a.ws.close();
    await closed;

    const res = await broadcast({
      type: "agent_state",
      payload: { agentId: "agent-c", duty: "idle" },
    });
    expect(res.status).toBe(204);

    const late = await connect();
    const payload = expectSnapshot(parse(await late.snapshot));
    expect(payload.agents).toContainEqual({ id: "agent-c", duty: "idle" });

    late.ws.close();
  });
});
