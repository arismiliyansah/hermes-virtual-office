import { Hono } from "hono";
import {
  requireAuth,
  type AuthBindings,
  type AuthVariables,
} from "./auth";
import { notify, type Broadcast } from "./broadcast";
import {
  addMinutes,
  createMeeting,
  getMeetingWithMinutes,
  listAgents,
  listMeetings,
  writeAudit,
  type AgentRow,
} from "./db";
import { HermesError } from "./hermes";
import { rateLimit } from "./ratelimit";

export const MEETING_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;
export const DEFAULT_MEETING_ROOM = "Ruang Kaca";

/**
 * The slice of HermesClient the meeting routes need. Tests inject an in-memory
 * implementation because workerd cannot reach the node:http mock server.
 */
export interface HermesMeetingApi {
  sendMessage(
    agentId: string,
    text: string,
  ): Promise<{ reply: string; sessionId: string }>;
}

export interface MeetingRouteDeps {
  hermes: HermesMeetingApi;
  db: D1Database;
  broadcast?: Broadcast;
}

type MeetingEnv = { Bindings: AuthBindings; Variables: AuthVariables };

function turnPrompt(title: string, position: number, total: number): string {
  return `Rapat "${title}" sedang berlangsung. Kamu peserta giliran ${position} dari ${total}. Sampaikan pendapat singkatmu.`;
}

function minutesPrompt(title: string, transcript: string): string {
  return `Berikut transkrip rapat "${title}":\n${transcript}\n\nSebagai sekretaris rapat, tulis notulen singkat rapat ini.`;
}

function agentName(agents: Map<string, AgentRow>, id: string): string {
  const name = agents.get(id)?.name?.trim();
  return name !== undefined && name.length > 0 ? name : id;
}

async function setMeetingStatus(
  db: D1Database,
  id: string,
  status: string,
): Promise<void> {
  await db
    .prepare("UPDATE meetings SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
}

/** A failed round must still return its 502 when the bookkeeping write fails. */
async function markFailed(db: D1Database, id: string): Promise<void> {
  try {
    await setMeetingStatus(db, id, "failed");
  } catch {
    // The upstream failure is the useful error; swallow the status write.
  }
}

export function createMeetingRoutes(deps: MeetingRouteDeps): Hono<MeetingEnv> {
  const router = new Hono<MeetingEnv>();
  const limiter = rateLimit({ ...MEETING_RATE_LIMIT, scope: "meetings" });

  router.use(
    "*",
    (c, next) => requireAuth(c.env.SESSION_SECRET)(c, next),
    limiter,
  );

  router.post("/meetings", async (c) => {
    const body = await c.req
      .json<{ title?: unknown; participantIds?: unknown }>()
      .catch(() => null);

    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const rawParticipants = body?.participantIds;

    if (title.length === 0 || !Array.isArray(rawParticipants)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (
      !rawParticipants.every(
        (id) => typeof id === "string" && id.trim().length > 0,
      )
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const participants = (rawParticipants as string[]).map((id) => id.trim());
    if (participants.length < 2) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const meetingId = crypto.randomUUID();
    await createMeeting(deps.db, {
      id: meetingId,
      title,
      room: DEFAULT_MEETING_ROOM,
      status: "running",
    });

    try {
      const agents = new Map(
        (await listAgents(deps.db)).map((agent) => [agent.id, agent]),
      );

      // One round of turns, strictly in the order the caller supplied.
      const transcript: string[] = [];
      for (const [index, agentId] of participants.entries()) {
        const { reply } = await deps.hermes.sendMessage(
          agentId,
          turnPrompt(title, index + 1, participants.length),
        );
        transcript.push(`[${agentName(agents, agentId)}]: ${reply}`);
        await notify(deps.broadcast, {
          type: "meeting_turn",
          payload: { agentId, text: reply },
        });
      }

      const rawTranscript = transcript.join("\n");
      const secretary =
        participants.find((id) => agents.get(id)?.role === "Manager") ??
        participants[0];

      const { reply: secretaryReply } = await deps.hermes.sendMessage(
        secretary,
        minutesPrompt(title, rawTranscript),
      );
      const minutes =
        secretaryReply.trim().length > 0 ? secretaryReply : rawTranscript;

      await addMinutes(deps.db, {
        id: crypto.randomUUID(),
        meeting_id: meetingId,
        content: minutes,
      });
      await setMeetingStatus(deps.db, meetingId, "done");
      await writeAudit(deps.db, {
        userId: c.get("userId"),
        action: "meeting.create",
        detail: JSON.stringify({
          meetingId,
          title,
          participants,
          secretary,
        }),
      });
      await notify(deps.broadcast, {
        type: "event",
        payload: { text: `Rapat selesai: ${title}`, ts: Date.now() },
      });

      const stored = await getMeetingWithMinutes(deps.db, meetingId);
      if (stored === null) {
        throw new Error(`meeting ${meetingId} disappeared after creation`);
      }

      return c.json(stored, 201);
    } catch (error) {
      if (error instanceof HermesError) {
        await markFailed(deps.db, meetingId);
        return c.json({ error: "hermes_unavailable" }, 502);
      }
      throw error;
    }
  });

  router.get("/meetings", async (c) => {
    return c.json({ meetings: await listMeetings(deps.db) });
  });

  router.get("/meetings/:id", async (c) => {
    const stored = await getMeetingWithMinutes(deps.db, c.req.param("id"));
    if (stored === null) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.json(stored);
  });

  return router;
}
