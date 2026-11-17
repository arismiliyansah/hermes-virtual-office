# Hermes API notes

Status: **provisional** as of 2026-11-18. Paths and payloads below were chosen while
building the Worker; they have not yet been verified against a real Hermes install.
`HermesClient` in `src/hermes.ts` is the stable contract used by the API routes — if
recon finds different gateway paths or shapes, change the adapter internals, not the
method signatures.

## Adapter behaviour

- `new HermesClient({ origin, secret, fetchImpl? })`; `origin` is the tunnel/proxy base
  URL (trailing slashes trimmed), `fetchImpl` defaults to the global `fetch`. Use a host
  root without a path prefix: the signed pathname is the path appended to `origin`, and
  it must match the pathname the auth proxy reconstructs.
- Every request is signed with `signedHeaders` (`src/sign.ts`), producing
  `x-hvo-timestamp`, `x-hvo-nonce`, and `x-hvo-signature`. Canonical string:
  `METHOD\nPATHNAME\nTIMESTAMP\nNONCE\nSHA256HEX(BODY)`.
- `METHOD` is uppercase; `PATHNAME` is the URL pathname without the query string; the
  body hash is taken over the exact JSON string sent on the wire.
- Requests time out after 10 seconds via `AbortSignal.timeout`.
- HTTP non-2xx → `HermesError` with `code: "bad_response"`; network failure/abort/
  dropped connection → `HermesError` with `code: "unreachable"`; invalid JSON on a 2xx
  also maps to `"bad_response"`.
- `Duty` lives in `src/duty.ts` and is re-exported from `src/hermes.ts`. Task 7 adds
  `resolveDuty` to the same file.
- Chat replies are **non-streaming** in v1: `sendMessage` waits for one JSON response
  with `{ reply, sessionId }`. Streaming is deferred until the gateway is confirmed to
  support SSE (see below).

## Provisional endpoints

| Method + path | Client method | Request body | Expected response |
| --- | --- | --- | --- |
| `GET /agents` | `listAgents` | — | `AgentSummary[]` |
| `GET /tasks` | `listTasks` | — | `TaskCard[]` |
| `POST /tasks` | `createTask` | `{ title, owner }` | `TaskCard` |
| `POST /tasks/:id/status` | `updateTaskStatus` | `{ status }` | `TaskCard` |
| `POST /agents/:id/messages` | `sendMessage` | `{ text }` | `{ reply, sessionId }` |
| `GET /crons` | `listCrons` | — | `CronJob[]` |
| `PATCH /crons/:id` | `setCronEnabled` | `{ enabled }` | `CronJob` |
| `POST /crons/:id/run` | `runCron` | — | `{ runId }` |
| `POST /a2a/call` | `a2aCall` | `{ from, to, message }` | `{ ok: true }` |

IDs are URL-encoded when interpolated into a path. `runCron` sends an empty body.
`tests/mock-hermes.ts` implements exactly this table and verifies request HMACs with
`node:crypto`, independently of `src/sign.ts` (the same way `connector/auth-proxy.mjs`
does).

## Manual recon against the owner's install

Run this on the machine that hosts Hermes, with the tunnel/auth-proxy available.
Record findings in this file and adjust `src/hermes.ts` internals as needed.

1. **Locate the gateway.** Inspect the installed Hermes version, its config, and any
   documented HTTP API (`hermes --help`, service unit, or config files). Note the
   default listen address/port and whether an HTTP server is enabled.
2. **Probe through the existing path.** Start `connector/auth-proxy.mjs` with the shared
   `HVO_HMAC_SECRET` and point `HERMES_UPSTREAM` at the gateway. A request without
   valid HMAC headers must return `401`; a correctly signed request must reach Hermes.
3. **Sign manual requests.** Use `signedHeaders(secret, method, pathname, body)` from
   `src/sign.ts` in a Node script/REPL, set the three `x-hvo-*` headers, then `curl`
   the proxy. Keep method uppercase, paths query-free, and the body byte-identical to
   what was hashed.
4. **Verify each mapping.** For every row above, confirm the real path, request body,
   status code, and response shape. In particular:
   - `status` values returned in `GET /agents` must fit
     `"meeting" | "a2a" | "desk" | "review" | "idle"`;
   - `TaskCard.owner` is an agent id or `null`;
   - `CronJob.agentId` identifies the owning agent;
   - `sendMessage` returns a reusable `sessionId`;
   - `POST /a2a/call` returns `{ "ok": true }` on success.
5. **If paths/shapes differ,** keep the public `HermesClient` methods unchanged and
   translate inside the adapter. Update this table so Tasks 9–12 and tests stay honest.
6. **If the gateway has no HTTP endpoints (CLI-only),** add a shim in
   `connector/auth-proxy.mjs` (or a module it imports) that maps these HTTP paths onto
   CLI invocations and normalizes stdout to the JSON shapes above. Keep HMAC
   verification at the proxy border, keep the shim dependency-free, and do not expose
   the CLI outside the owner's machine. `HermesClient` must not change for this.
7. **Re-run contract tests** after recon: `pnpm vitest run tests/hermes.test.ts` covers
   signing, error mapping, and payload shapes against the mock. Add fixtures for the
   real shapes if they differ.

## Deferred / open questions

- **Streaming chat:** v1 is request/response only. SSE or chunked streaming is deferred
  until the gateway is proven to emit SSE; the adapter and API routes would then add a
  separate streaming method rather than changing `sendMessage`.
- **A2A:** the provisional `POST /a2a/call` assumes a synchronous acknowledgement.
  Confirm whether the gateway queues the call and what failure shape it returns.
- **Cron runs:** `runCron` assumes a synchronous `{ runId }`. If runs are asynchronous,
  the id can still be returned immediately, but logs/status would need another route.
- **Auth scope:** HMAC proves possession of the shared secret for the whole tunnel. Any
  per-agent authorization must be enforced by the gateway or the Worker, not by path
  naming.
