import { DurableObject } from "cloudflare:workers";
import type { Duty } from "./duty";
import type { Env } from "./env";
import type { ServerMsg } from "./protocol";

interface Snapshot {
  agents: { id: string; duty: Duty }[];
  tasks: unknown[];
}

const SNAPSHOT_KEY = "snapshot";

function emptySnapshot(): Snapshot {
  return { agents: [], tasks: [] };
}

function withAgent(snapshot: Snapshot, agentId: string, duty: Duty): Snapshot {
  const agents = snapshot.agents.filter((agent) => agent.id !== agentId);
  agents.push({ id: agentId, duty });
  return { agents, tasks: snapshot.tasks };
}

export class OfficeHub extends DurableObject<Env> {
  private snapshot: Snapshot = emptySnapshot();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.snapshot =
        (await ctx.storage.get<Snapshot>(SNAPSHOT_KEY)) ?? emptySnapshot();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/broadcast" && request.method === "POST") {
      return this.broadcast(request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.upgrade();
    }

    return new Response(null, { status: 404 });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Office state is server-owned; client frames are not part of the protocol.
  }

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  webSocketError(ws: WebSocket): void {
    ws.close(1011, "socket_error");
  }

  private upgrade(): Response {
    const snapshot = this.snapshot;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", payload: snapshot }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(request: Request): Promise<Response> {
    const message = (await request.json()) as ServerMsg;

    if (message.type === "agent_state") {
      this.snapshot = withAgent(
        this.snapshot,
        message.payload.agentId,
        message.payload.duty,
      );
      await this.ctx.storage.put(SNAPSHOT_KEY, this.snapshot);
    } else if (message.type === "snapshot") {
      this.snapshot = {
        agents: message.payload.agents,
        tasks: message.payload.tasks,
      };
      await this.ctx.storage.put(SNAPSHOT_KEY, this.snapshot);
    }

    this.sendToAll(JSON.stringify(message));
    return new Response(null, { status: 204 });
  }

  private sendToAll(frame: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        ws.close(1011, "send_failed");
      }
    }
  }
}
