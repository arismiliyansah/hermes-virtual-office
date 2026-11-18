# Hermes Virtual Office — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun kantor virtual 2.5D yang di-host di Cloudflare untuk memantau dan mengoperasikan Hermes Agent yang berjalan di VPS/laptop pemilik lewat Cloudflare Tunnel dengan auth sendiri.

**Architecture:** Worker (Hono) menyajikan SPA SolidJS dan REST API; satu Durable Object `OfficeHub` memegang state kantor dan fan-out WebSocket (Hibernation API); D1 menyimpan data persisten (user, mirror kanban, meeting, audit). Akses ke Hermes lewat hostname tunnel yang ditandatangani HMAC-SHA256 dan diverifikasi oleh `auth-proxy` Node tanpa dependensi di mesin pemilik, yang meneruskan ke gateway Hermes di loopback.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, Durable Objects (SQLite-backed), D1, Workers Static Assets, Vite + SolidJS + Tailwind v4, Vitest + @cloudflare/vitest-pool-workers, Node ≥ 22 (connector, `node:test`).

**Spec:** `docs/superpowers/specs/2026-11-18-hermes-virtual-office-design.md` (mockup acuan: `mockups/kantor-utama-v1.html`, `mockups/kantor-mobile-v1.html`)

## Global Constraints

- Runtime Worker: Cloudflare Workers + Hono; satu Durable Object `OfficeHub` per kantor; persistensi D1.
- Sesi user: cookie `__Host-session` — `Secure`, `Path=/`, `HttpOnly`, `SameSite=Lax`, tanpa `Domain`; nilai = payload base64url + HMAC-SHA256.
- Auth tunnel: HMAC-SHA256, toleransi jam ±300 detik, nonce anti-replay TTL 600 detik; TIDAK memakai Cloudflare Access.
- Rate limit endpoint yang meneruskan ke tunnel: 60 request/menit per user (fixed window), lewat → 429.
- Hermes adalah sumber kebenaran: kanban tanpa kartu lokal; konflik sinkron Hermes menang; status tak dikenal TIDAK boleh dikarang (disimpan sebagai `office_label`).
- Agent idle tidak pernah memanggil model; renderer scene tidak boleh mengimpor modul API/adapter.
- Mobile: semua target sentuh ≥ 44 px; operasi memakai bottom sheet; tidak ada interaksi hover-only.
- UI copy berbahasa Indonesia; palet siang/malam mengikuti mockup (token di `app/scene/palette.ts`).
- Connector berjalan dengan Node ≥ 22, tanpa dependensi npm.

## Review Focus

1. **Skew jam Worker ↔ mesin pemilik** — request dengan timestamp basi/akan datang harus ditolak bersih (401), bukan diproses; uji di Task 3 (stale, future, replay nonce).
2. **Tunnel putus / mesin offline** — UI harus menampilkan status terputus yang jelas dan klien WebSocket reconnect dengan backoff, bukan diam; uji di Task 16 (`backoffMs`) + Task 8 (WS close).
3. **Idle membakar token** — duty `idle` tidak boleh memicu panggilan model; uji di Task 7 (prioritas duty) dan Task 14 (renderer menerima snapshot polos, tanpa klien API).
4. **Status task Hermes tak dikenal** — perpindahan kolom ke status yang tidak ada di Hermes harus gagal-tertutup (label lokal), bukan mengirim status karangan; uji di Task 10.
5. **Cookie `__Host-` di dev/localhost** — atribut `Secure`/`Path=/`/tanpa `Domain` wajib tetap ada; perilaku login di localhost terdokumentasi; uji atribut cookie di Task 6.

---

### Task 1: Scaffold Worker + test harness

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts`, `tests/health.test.ts`

**Interfaces:**
- Consumes: —
- Produces: Worker default export (Hono app) dengan `GET /api/health` → `{ ok: true }`; skrip npm `test`, `dev`, `deploy`, `build:app`.

- [ ] **Step 1: Inisialisasi repo**

```bash
git init
```
Buat `.gitignore`: `node_modules/`, `dist/`, `.wrangler/`, `.superpowers/`, `app/dist/`.

- [ ] **Step 2: Tulis package.json + tsconfig + wrangler.jsonc**

`package.json` deps: `hono`; devDeps: `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `typescript`, `@types/node`. Skrip: `"test": "vitest run"`, `"dev": "wrangler dev"`, `"deploy": "wrangler deploy"`.

`wrangler.jsonc`: `name: "hermes-virtual-office"`, `main: "src/index.ts"`, `compatibility_date: "2026-11-01"`, `assets: { directory: "app/dist", binding: "ASSETS", not_found_handling: "single-page-application" }`, D1 binding `DB` (`database_name: "hermes-office"`), DO binding `OFFICE_HUB` → class `OfficeHub` (migration tag `v1`), vars `HERMES_ORIGIN: "https://hermes.example-tunnel.dev"`.

- [ ] **Step 3: Tulis failing test health**

`tests/health.test.ts`:
```ts
import { SELF } from "cloudflare:test";
it("GET /api/health → ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 4: Jalankan test — harus FAIL**

Run: `pnpm vitest run tests/health.test.ts`
Expected: FAIL (route belum ada).

- [ ] **Step 5: Implementasi minimal + konfigurasi vitest**

`src/index.ts`: Hono app, `app.get("/api/health", ...)` → `{ok:true}`, `export default app`. `vitest.config.ts`: `defineWorkersConfig` + `poolOptions.workers.wrangler.configPath`.

- [ ] **Step 6: Jalankan test — PASS**

Run: `pnpm vitest run tests/health.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold worker, vitest pool, health route"
```

---

### Task 2: Penandatanganan HMAC request (sisi Worker)

**Files:**
- Create: `src/sign.ts`, `tests/sign.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `canonicalString(opts: {method: string; path: string; timestamp: number; nonce: string; body: string}): Promise<string>` — format persis: `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256HEX(BODY)`.
  - `signRequest(secret: string, opts: CanonicalOpts): Promise<{signature: string}>` — HMAC-SHA256, keluaran hex.
  - `signedHeaders(secret: string, method: string, path: string, body: string, now?: Date): Promise<{"x-hvo-timestamp": string; "x-hvo-nonce": string; "x-hvo-signature": string}>`.

- [ ] **Step 1: Failing test — format kanonik & signature**

Uji: (a) `canonicalString` menghasilkan urutan baris persis seperti di atas dan `SHA256HEX(BODY)` = hash hex body; (b) `signRequest` sama dengan HMAC yang dihitung ulang di test memakai `crypto.subtle` atas `canonicalString` (pembanding independen), hex 64 karakter; (c) `signedHeaders` mengembalikan tiga header dengan timestamp = epoch detik `now`.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/sign.test.ts`

- [ ] **Step 3: Implementasi `src/sign.ts`**

`crypto.subtle.digest("SHA-256")` + `crypto.subtle.importKey/sign` (HMAC). Nonce = 16 byte acak hex.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/sign.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sign.ts tests/sign.test.ts && git commit -m "feat: HMAC request signing with canonical string"
```

---

### Task 3: Connector `auth-proxy`

**Files:**
- Create: `connector/auth-proxy.mjs`, `connector/auth-proxy.test.mjs`, `connector/README.md`

**Interfaces:**
- Consumes: format kanonik Task 2 (implementasi pembanding terpisah di proxy).
- Produces: server HTTP yang membaca env `HVO_HMAC_SECRET` (wajib), `HERMES_UPSTREAM` (default `http://127.0.0.1:8788`), `PORT` (default `8787`); memverifikasi `x-hvo-timestamp` (±300 dtk), `x-hvo-nonce` (TTL 600 dtk), `x-hvo-signature`; meneruskan method/path/body ke upstream tanpa header auth; 401 untuk gagal verifikasi.

- [ ] **Step 1: Failing test (`node:test`)**

Upstream palsu menggemakan method+path+body. Kasus: (a) request valid → 200 + body diteruskan; (b) timestamp −301 dtk → 401; (c) timestamp +301 dtk → 401; (d) nonce sama dua kali → 401 pada yang kedua; (e) signature salah → 401.

- [ ] **Step 2: Jalankan — FAIL**

Run: `node --test connector/auth-proxy.test.mjs`

- [ ] **Step 3: Implementasi `auth-proxy.mjs`**

`node:http` + `node:crypto`, tanpa dependensi; bandingkan signature dengan `timingSafeEqual`; simpan nonce di `Map` dengan expiry dan bersihkan berkala.

- [ ] **Step 4: PASS**

Run: `node --test connector/auth-proxy.test.mjs` → PASS.

- [ ] **Step 5: Tulis README + commit**

README: cara menjalankan (`HVO_HMAC_SECRET=… node connector/auth-proxy.mjs`), contoh unit systemd/launchd.
```bash
git add connector && git commit -m "feat: zero-dep HMAC auth proxy for tunnel"
```

---

### Task 4: Adapter `HermesClient` + mock server

**Files:**
- Create: `src/hermes.ts`, `tests/mock-hermes.ts`, `tests/hermes.test.ts`, `docs/hermes-api-notes.md`

**Interfaces:**
- Consumes: `signedHeaders` (Task 2).
- Produces (dipakai Task 9–12):
```ts
export type Duty = "meeting" | "a2a" | "desk" | "review" | "idle";
export interface AgentSummary { id: string; name: string; role: string; status: Duty; }
export interface TaskCard { id: string; title: string; status: string; owner: string | null; }
export interface CronJob { id: string; name: string; schedule: string; enabled: boolean; agentId: string; }
export class HermesError extends Error { code: "unreachable" | "bad_response"; }
export class HermesClient {
  constructor(opts: { origin: string; secret: string; fetchImpl?: typeof fetch });
  listAgents(): Promise<AgentSummary[]>;
  listTasks(): Promise<TaskCard[]>;
  createTask(title: string, ownerAgentId: string | null): Promise<TaskCard>;
  updateTaskStatus(id: string, status: string): Promise<TaskCard>;
  sendMessage(agentId: string, text: string): Promise<{ reply: string; sessionId: string }>;
  listCrons(): Promise<CronJob[]>;
  setCronEnabled(id: string, enabled: boolean): Promise<CronJob>;
  runCron(id: string): Promise<{ runId: string }>;
  a2aCall(from: string, to: string, message: string): Promise<{ ok: true }>;
}
```
- Path provisional (dicatat di `docs/hermes-api-notes.md`): `GET /agents`, `GET/POST /tasks`, `POST /tasks/:id/status`, `POST /agents/:id/messages`, `GET /crons`, `PATCH /crons/:id`, `POST /crons/:id/run`, `POST /a2a/call`.

- [ ] **Step 1: Failing contract tests**

`tests/mock-hermes.ts`: server `node:http` di port acak yang memverifikasi HMAC dengan secret sama dan mengembalikan fixture. Test: (a) `listAgents` mem-parsing fixture; (b) setiap request membawa 3 header HMAC valid (mock menolak bila tidak); (c) HTTP 500 → `HermesError("bad_response")`; (d) koneksi ditutup → `HermesError("unreachable")`; (e) `sendMessage` → `{reply, sessionId}`; (f) `createTask` mengirim title+owner dan mengembalikan kartu membuat `{title, owner}`.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/hermes.test.ts`

- [ ] **Step 3: Implementasi adapter**

`fetchImpl` default `fetch`; timeout 10 dtk via `AbortSignal.timeout`; non-2xx → `bad_response`; network error → `unreachable`. Catat di `docs/hermes-api-notes.md`: tabel path provisional + instruksi recon manual terhadap instalasi pemilik (termasuk opsi shim CLI di auth-proxy bila gateway tanpa endpoint HTTP; antarmuka `HermesClient` tidak berubah). Catat juga: balasan chat v1 non-streaming; streaming ditunda sampai gateway terbukti mendukung SSE.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/hermes.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hermes.ts tests/mock-hermes.ts tests/hermes.test.ts docs/hermes-api-notes.md
git commit -m "feat: Hermes adapter with HMAC requests and mock server"
```

---

### Task 5: Skema D1 + seed + helper db

**Files:**
- Create: `migrations/0001_init.sql`, `src/db.ts`, `scripts/hash-password.mjs`, `scripts/seed.sql`, `tests/db.test.ts`

**Interfaces:**
- Consumes: —
- Produces: tipe row (`UserRow`, `AgentRow`, `TaskRow`, `MeetingRow`, `MinuteRow`, `AuditRow`) dan fungsi `getUserByEmail(db, email)`, `insertUser(db, {id,email,passwordHash})`, `listAgents(db)`, `upsertAgent(db, agent)`, `listTasks(db)`, `upsertTask(db, task)`, `writeAudit(db, {userId, action, detail})`, `createMeeting(db, meeting)`, `addMinutes(db, minute)`, `getMeetingWithMinutes(db, id)`.

- [ ] **Step 1: Failing test skema**

D1 di vitest pool + `applyD1Migrations`: (a) insert+select user; (b) email duplikat → error; (c) `tasks` punya kolom `office_label`; `agents.machine_id` default `'main'`; (d) audit increment id.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/db.test.ts`

- [ ] **Step 3: Implementasi SQL + helper**

Tabel: `users(id TEXT PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`; `agents(id TEXT PK, machine_id TEXT NOT NULL DEFAULT 'main', name TEXT, role TEXT, color TEXT, desk_index INTEGER)`; `tasks(id TEXT PK, title TEXT, status TEXT, office_label TEXT, owner_agent TEXT, updated_at TEXT)`; `meetings(id TEXT PK, title TEXT, room TEXT, status TEXT, created_at)`; `minutes(id TEXT PK, meeting_id TEXT REFERENCES meetings(id), content TEXT, created_at)`; `audit(id INTEGER PK AUTOINCREMENT, user_id TEXT, action TEXT, detail TEXT, created_at)`.

`scripts/hash-password.mjs`: cetak `pbkdf2$<iter>$<salt-b64url>$<hash-b64url>` dari argumen. `scripts/seed.sql`: INSERT user dengan placeholder hash hasil skrip.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/db.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations src/db.ts scripts tests/db.test.ts && git commit -m "feat: D1 schema, db helpers, seed scripts"
```

---

### Task 6: Auth user (login, cookie `__Host-`, CSRF)

**Files:**
- Create: `src/auth.ts`, `tests/auth.test.ts`
- Modify: `src/index.ts` (pasang rute)

**Interfaces:**
- Consumes: `getUserByEmail` (Task 5).
- Produces: `hashPassword(pw): Promise<string>`, `verifyPassword(pw, stored): Promise<boolean>`, `createSession(userId, secret, now?): string`, `readSession(value, secret, now?): {userId, csrf} | null`, `requireAuth(secret): MiddlewareHandler` (set `c.set("userId")`); rute `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. Mutasi (`POST/PUT/DELETE` selain login) wajib header `x-csrf-token` = `csrf` sesi; jika tidak → 403.

- [ ] **Step 1: Failing tests**

(a) login benar → 200 + `Set-Cookie` mengandung `__Host-session=`, `Secure`, `Path=/`, `HttpOnly`, `SameSite=Lax`, TANPA `Domain=`; (b) password salah → 401; (c) cookie expired → 401 di `/api/auth/me`; (d) mutasi tanpa `x-csrf-token` → 403; (e) dengan csrf benar → lolos.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/auth.test.ts`

- [ ] **Step 3: Implementasi `src/auth.ts` + rute**

PBKDF2-SHA256 100.000 iterasi, salt 16 byte, format `pbkdf2$100000$<salt>$<hash>` base64url. Sesi: payload `{uid, csrf, exp}` base64url + `.` + HMAC (env `SESSION_SECRET`), berlaku 7 hari. Catat di komentar: `__Host-` + `Secure` berfungsi di localhost (port loopback) pada browser modern.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/auth.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/index.ts tests/auth.test.ts && git commit -m "feat: owner auth with __Host- session and CSRF"
```

---

### Task 7: Duty state machine (murni)

**Files:**
- Create: `src/duty.ts`, `tests/duty.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `interface AgentActivity { agentId: string; taskActive: boolean; liveChat: boolean; cronRunning: boolean; meetingId: string | null; a2aWith: string | null; reviewOf: string | null }`; `resolveDuty(a: AgentActivity): Duty`; `resolveAll(acts: AgentActivity[]): Record<string, Duty>`.

- [ ] **Step 1: Failing tests prioritas**

Matriks: meeting mengalahkan semua; a2a mengalahkan desk; desk (task/chat/cron) mengalahkan review; review mengalahkan idle; idle hanya saat semua false/null. Uji `resolveDuty` murni — tanpa parameter klien/fetch.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/duty.test.ts`

- [ ] **Step 3: Implementasi**

Urutan prioritas ketat sesuai spec §8.6.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/duty.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/duty.ts tests/duty.test.ts && git commit -m "feat: duty state machine with strict priority"
```

---

### Task 8: Durable Object `OfficeHub`

**Files:**
- Create: `src/protocol.ts`, `src/hub.ts`, `tests/hub.test.ts`
- Modify: `src/index.ts` (rute `GET /api/ws` dengan `requireAuth`)

**Interfaces:**
- Consumes: `requireAuth` (Task 6).
- Produces:
```ts
// src/protocol.ts
export type ServerMsg =
  | { type: "snapshot"; payload: { agents: { id: string; duty: duty.Duty }[]; tasks: unknown[] } }
  | { type: "agent_state"; payload: { agentId: string; duty: duty.Duty } }
  | { type: "event"; payload: { text: string; ts: number } }
  | { type: "meeting_turn"; payload: { agentId: string; text: string } };
```
`class OfficeHub` (DurableObject): `fetch` menerima upgrade WS lewat **WebSocket Hibernation API** (`state.acceptWebSocket` + handler `webSocketMessage`/`webSocketClose`); `POST /broadcast` internal menerima `ServerMsg`; menyimpan snapshot terakhir di storage dan mengirim `snapshot` ke koneksi baru.

- [ ] **Step 1: Failing tests**

(a) dua klien WS terhubung; `POST /broadcast` `agent_state` → kedua klien menerima pesan identik; (b) klien baru setelah broadcast menerima `snapshot` berisi state terakhir; (c) klien disconnect → tidak error.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/hub.test.ts`

- [ ] **Step 3: Implementasi hub + rute ws**

`GET /api/ws` (auth) → stub `idFromName("main")`; hub memakai hibernation API agar bisa tidur saat sepi (mitigasi biaya §10).

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/hub.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/hub.ts src/index.ts tests/hub.test.ts
git commit -m "feat: OfficeHub durable object with hibernatable websockets"
```

---

### Task 9: API agents + chat + auto-desk + rate limit

**Files:**
- Create: `src/ratelimit.ts`, `src/routes-agents.ts`, `tests/agents.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `HermesClient.listAgents/sendMessage` (Task 4), `listAgents/upsertAgent` (Task 5).
- Produces: `rateLimit(opts: {limit: number; windowMs: number}): MiddlewareHandler` (fixed window per `userId`, 429 `{error:"rate_limited"}`; dipakai semua rute yang meneruskan ke tunnel). `GET /api/agents` → `{agents: ({id,name,role,color,desk: number|null,status})[]}` — sync dari Hermes; agent baru dapat `desk_index` kosong terkecil; > 6 agent → `desk: null` (hotdesk). `POST /api/agents/:id/messages` `{text}` → `{reply, sessionId}`.

- [ ] **Step 1: Failing tests**

(a) sync pertama: 6 agent → desk 0..5 tersimpan di D1; (b) agent ke-7 → `desk: null`; (c) `POST messages` meneruskan ke mock dan mengembalikan `reply`; (d) tanpa auth → 401; tanpa csrf → 403; (e) request ke-61 dalam satu menit → 429.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/agents.test.ts`

- [ ] **Step 3: Implementasi**

Terapkan `rateLimit` pada rute agents/chat. Catat: balasan chat v1 sinkron (streaming ditunda, lihat Task 4).

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/agents.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ratelimit.ts src/routes-agents.ts src/index.ts tests/agents.test.ts
git commit -m "feat: agents sync with auto desks, chat proxy, rate limit"
```

---

### Task 10: API tasks/kanban (Hermes menang + assign tugas)

**Files:**
- Create: `src/routes-tasks.ts`, `tests/tasks.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `listTasks/createTask/updateTaskStatus` (Task 4), helper db (Task 5), `rateLimit` (Task 9).
- Produces: `GET /api/tasks` (refresh dari Hermes lalu kembalikan mirror D1); `POST /api/tasks` `{title, ownerAgentId?}` → `createTask` di Hermes lalu upsert mirror; `POST /api/tasks/:id/status` `{status}` — status ∈ himpunan status Hermes yang pernah terlihat → kirim ke Hermes; di luar itu → simpan hanya `office_label`, JANGAN kirim ke Hermes. Semua mutasi menulis audit.

- [ ] **Step 1: Failing tests**

(a) refresh menimpa perubahan lokal (Hermes menang); (b) status tak dikenal → `office_label` tersimpan, tidak ada request upstream (counter mock = 0); (c) status dikenal → diteruskan; (d) `POST /api/tasks` membuat task di Hermes dan mirror; (e) audit tercatat untuk setiap mutasi.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/tasks.test.ts`

- [ ] **Step 3: Implementasi rute + rate limit + audit**

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/tasks.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes-tasks.ts src/index.ts tests/tasks.test.ts
git commit -m "feat: kanban sync, Hermes-wins, office labels, task assign"
```

---

### Task 11: API cron

**Files:**
- Create: `src/routes-cron.ts`, `tests/cron.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `listCrons/setCronEnabled/runCron` (Task 4), `writeAudit` (Task 5), `rateLimit` (Task 9).
- Produces: `GET /api/cron`; `POST /api/cron/:id/toggle` `{enabled}`; `POST /api/cron/:id/run`.

- [ ] **Step 1: Failing tests**

(a) list memetakan fixture; (b) toggle meneruskan boolean; (c) run mengembalikan `runId`; (d) upstream error → 502 `{error:"unreachable"}`; (e) audit tercatat untuk toggle dan run.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/cron.test.ts`

- [ ] **Step 3: Implementasi**

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/cron.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes-cron.ts src/index.ts tests/cron.test.ts
git commit -m "feat: cron management endpoints"
```

---

### Task 12: API meetings + notulen oleh sekretaris

**Files:**
- Create: `src/routes-meetings.ts`, `tests/meetings.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `sendMessage` (Task 4), `createMeeting/addMinutes/getMeetingWithMinutes` (Task 5), `rateLimit` (Task 9).
- Produces: `POST /api/meetings` `{title, participantIds}` → 400 bila `< 2` peserta; meeting `status:"running"`; satu ronde giliran berurutan via `sendMessage` (urutan = `participantIds`); **sekretaris** = agent dengan `role` "Manager" (fallback: peserta pertama) diminta menulis notulen lewat `sendMessage` berisi transkrip; minutes = balasan sekretaris (fallback: transkrip mentah bila balasan kosong); status `done`. `GET /api/meetings/:id` → meeting + minutes.

- [ ] **Step 1: Failing tests**

(a) 1 peserta → 400; (b) 2 peserta → 2 giliran terkirim dengan urutan benar (mock mencatat); (c) mock menerima panggilan sekretaris dengan transkrip di prompt; (d) minutes tersimpan = balasan sekretaris; (e) status `done` + audit tercatat.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/meetings.test.ts`

- [ ] **Step 3: Implementasi**

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/meetings.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes-meetings.ts src/index.ts tests/meetings.test.ts
git commit -m "feat: meetings with turns and secretary-written minutes"
```

---

### Task 13: Scaffold SPA + login + shell responsif

**Files:**
- Create: `app/index.html`, `app/main.tsx`, `app/App.tsx`, `app/api.ts`, `app/styles.css`, `app/ui/Login.tsx`, `app/ui/Topbar.tsx`, `app/ui/Dock.tsx`, `app/ui/shell.test.tsx`, `app/vitest.config.ts`
- Modify: `package.json` (deps `solid-js`, `vite`, `vite-plugin-solid`, `@solidjs/testing-library`, `happy-dom`; skrip `build:app`: `vite build app`)

**Interfaces:**
- Consumes: `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/logout` (Task 6).
- Produces: `App` dengan state `loading | login | office`; `Topbar` (wordmark, pill koneksi, toggle Siang/Malam, avatar); `Dock` tab Chat/Kanban/Meeting/Cron — desktop: dock kanan 372px; mobile (`max-width: 860px`): bottom sheet (handle tap = toggle), roster avatar; semua kontrol utama `min-h-11` (44px). Token warna CSS dari mockup.

- [ ] **Step 1: Failing tests**

(a) `me` 401 → render Login; submit memanggil login dengan body benar; (b) sukses → render office; (c) tap handle mobile → kelas `expanded`; (d) setiap kontrol utama punya `min-h-11`/`min-w-11`.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run --config app/vitest.config.ts`

- [ ] **Step 3: Implementasi shell + login**

- [ ] **Step 4: PASS + build**

Run: `pnpm vitest run --config app/vitest.config.ts` → PASS. `pnpm build:app` → `app/dist` terbentuk.

- [ ] **Step 5: Commit**

```bash
git add app package.json pnpm-lock.yaml
git commit -m "feat: solid spa shell with login and responsive dock"
```

---

### Task 14: Proyeksi isometrik, palet tema, layout, renderer

**Files:**
- Create: `app/scene/iso.ts`, `app/scene/palette.ts`, `app/scene/layout.ts`, `app/scene/viewport.ts`, `app/scene/renderer.ts`, `app/scene/scene.test.ts`, `app/scene/viewport.test.ts`, `app/ui/SceneToolbar.tsx`, `app/ui/scene-toolbar.test.tsx`, `app/theme.ts`, `app/theme.test.ts`

**Interfaces:**
- Consumes: tipe `Duty` dari `src/protocol.ts` (import tipe saja).
- Produces: `project(i, j, o?): {x, y}`; `diamond(c, w?, h?): Point[]`; `DAY: Palette`, `NIGHT: Palette` (nilai persis dari mockup); `LAYOUT` (6 meja, ruang meeting, lounge, rack, `MEET_PATH`);
  - `interface Viewport { zoom: number; rotation: 0|1|2|3; panX: number; panY: number }`; `defaultViewport: Viewport`; `clampZoom(z: number): number` (0.6–2.5); `nextRotation(r): 0|1|2|3` (wrap); `rotatePoint(i, j, rotation, cx, cy): {i: number; j: number}` (rotasi 90° CKeliling pusat grid `(cx,cy)`; 4× = identity; sprite tetap tegak karena rotasi di level koordinat); `viewStorageKey = "hermes-office-view"`.
  - `createScene(canvas, {palette, layout}): {draw(snapshot: {agents: {id: string; duty: Duty}[]}, viewport: Viewport): void}` — renderer hanya menerima data, TIDAK mengimpor `app/api.ts`/adapter.
  - `SceneToolbar` props `{viewport: Viewport; onChange(v: Viewport): void}` — tombol zoom − / +, rotate, reset; tiap tombol ≥ 44px; interaksi canvas: wheel zoom, drag pan, pinch dua jari, keyboard `+`/`-`/`R`.
  - `resolveInitialTheme(prefersDark, stored): "day"|"night"`; `themeStorageKey = "hermes-office-theme"`.

- [ ] **Step 1: Failing tests**

(a) `project(1,0) - project(0,0)` = `(+tw/2, +th/2)`; (b) `diamond` 4 titik urut atas-kanan-bawah-kiri; (c) `resolveInitialTheme` mendahulukan stored lalu prefers; (d) `createScene` dengan canvas stub + snapshot 6 agent tidak melempar error, dan modul scene tidak mengimpor `../api` (assert pada teks modul); (e) `clampZoom(0.1)=0.6`, `clampZoom(9)=2.5`; (f) `nextRotation` 0→1→2→3→0; (g) `rotatePoint(i,j,0,…)` = identity, 90° memutar tepat searah jarum jam di sekitar pusat grid, dan 4× rotasi = identity (toleransi 1e-9); (h) `SceneToolbar` menekan zoom − / + mengirim `onChange` dengan zoom ter-clamp dan tombol rotate mengirim rotasi berikutnya.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run --config app/vitest.config.ts`

- [ ] **Step 3: Implementasi (palet disalin dari mockup)**

Renderer menggambar ulang memakai `rotatePoint` untuk semua koordinat sebelum `project` dan mengurutkan depth berdasarkan koordinat terotasi; zoom/pan diterapkan sebagai transform canvas (`setTransform`) dengan pusat viewport; `SceneToolbar` memakai kontrol ≥ 44px, dan state viewport dipersist ke `localStorage[viewStorageKey]`.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run --config app/vitest.config.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/scene app/theme.ts app/theme.test.ts
git commit -m "feat: isometric scene, day/night palettes, theme resolution"
```

---

### Task 15: Panel Chat + Kanban

**Files:**
- Create: `app/ui/ChatPanel.tsx`, `app/ui/KanbanPanel.tsx`, `app/ui/panels.test.tsx`
- Modify: `app/ui/Dock.tsx`, `app/App.tsx`

**Interfaces:**
- Consumes: `GET /api/agents`, `POST /api/agents/:id/messages` (Task 9); `GET /api/tasks`, `POST /api/tasks`, `POST /api/tasks/:id/status` (Task 10); `createScene` (Task 14).
- Produces: panel chat (pilih agent dari kantor/roster → header + pesan + composer; kirim → tampilkan balasan + indikator mengetik sementara) dan panel kanban 4 kolom (`/api/tasks`; kartu `office_label` berlabel amber; "Setujui" → `POST /status` lalu refresh; tombol "Tugas baru" → `POST /api/tasks`). Snapshot WS dari `useOffice()` (Task 16) menggambar scene; `SceneToolbar` (Task 14) dipasang di App dengan state `Viewport` (zoom/rotate/pan) yang diteruskan ke `draw`.

- [ ] **Step 1: Failing tests**

(a) kirim pesan memanggil API `{text}` dan menampilkan `reply`; (b) kartu `office_label` tampil; (c) "Setujui" mengirim status tepat lalu kartu pindah; (d) error API tampil sebagai baris pesan, bukan crash.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run --config app/vitest.config.ts`

- [ ] **Step 3: Implementasi panel**

- [ ] **Step 4: PASS**

Run: `pnpm vitest run --config app/vitest.config.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/ui && git commit -m "feat: chat and kanban panels wired to api"
```

---

### Task 16: Klien WS + panel Meeting + Cron

**Files:**
- Create: `app/ui/useOffice.ts`, `app/ui/MeetingPanel.tsx`, `app/ui/CronPanel.tsx`, `app/ui/realtime.test.tsx`
- Modify: `app/ui/Dock.tsx`, `app/App.tsx`

**Interfaces:**
- Consumes: `ServerMsg` (Task 8); `GET/POST /api/cron` (Task 11); `POST /api/meetings`, `GET /api/meetings/:id` (Task 12).
- Produces: `backoffMs(attempt): number` (500·2^attempt, cap 15.000); `useOffice()` — koneksi `/api/ws`, reconnect dengan `backoffMs`, state `{connected, agents: Record<string, Duty>, events, meetingTurn}`; panel meeting (peserta + highlight `meeting_turn`, "Akhiri meeting" → GET minutes) dan panel cron (list/toggle/run; optimistik dengan revert saat error).

- [ ] **Step 1: Failing tests**

(a) `backoffMs(0..4)` = 500,1000,2000,4000,8000; cap 15.000; (b) WS close → `connected=false` lalu reconnect terjadwal (fake timers); (c) `meeting_turn` menandai pembicara; (d) toggle cron gagal → nilai kembali + baris error.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run --config app/vitest.config.ts`

- [ ] **Step 3: Implementasi realtime + panel**

- [ ] **Step 4: PASS**

Run: `pnpm vitest run --config app/vitest.config.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/ui && git commit -m "feat: realtime client with backoff, meeting and cron panels"
```

---

### Task 17: Deployment docs + konfigurasi connector + smoke check

**Files:**
- Create: `README.md`, `docs/deploy.md`, `deploy/cloudflared.example.yml`, `deploy/hermes-auth-proxy.service`, `scripts/seed.sh`, `scripts/smoke.mjs`, `tests/deploy.test.ts`

**Interfaces:**
- Consumes: semua task sebelumnya.
- Produces: `node scripts/smoke.mjs --check-config` yang memvalidasi env wajib (`HERMES_ORIGIN`, `SESSION_SECRET`, `HVO_HMAC_SECRET`); exit 0 bila lengkap, exit 1 + daftar yang kurang.

- [ ] **Step 1: Failing test konfigurasi**

Env kosong → exit 1 dan menyebut `HERMES_ORIGIN`; env lengkap → exit 0.

- [ ] **Step 2: Jalankan — FAIL**

Run: `pnpm vitest run tests/deploy.test.ts`

- [ ] **Step 3: Implementasi docs + config + smoke**

`README.md` (untuk repo publik): ringkasan proyek, tangkapan/rujukan mockup, arsitektur ringkas (Cloudflare app + Hermes di mesin sendiri via tunnel HMAC), prasyarat, quickstart dev, struktur repo, dan tautan ke `docs/deploy.md`, `docs/superpowers/specs/`, `docs/superpowers/plans/`. Tanpa klaim palsu: sebut status "v0.1".

`docs/deploy.md`: urutan `wrangler d1 create hermes-office` → apply migrations → `wrangler secret put SESSION_SECRET`/`HERMES_HMAC_SECRET` → set `HERMES_ORIGIN` → `pnpm build:app` → `wrangler deploy` → di mesin: auth-proxy + cloudflared ingress `hermes-office.example.com → http://127.0.0.1:8787`. Sertakan catatan NTP (skew HMAC), seed user (`scripts/seed.sh`), dan checklist smoke manual: login dari HP, banner terputus saat tunnel mati, tema malam, meeting ≥2 agent, setujui kartu.

- [ ] **Step 4: PASS**

Run: `pnpm vitest run tests/deploy.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy.md deploy scripts tests/deploy.test.ts
git commit -m "docs: deployment, tunnel config, smoke checks"
```

---

## Catatan eksekusi

- Urutan wajib 1→17; rute ditambahkan ke `src/index.ts` bertahap.
- Test Worker di `@cloudflare/vitest-pool-workers`; test SPA di `app/vitest.config.ts` (`happy-dom`).
- `docs/hermes-api-notes.md` diperbarui saat recon nyata; antarmuka `HermesClient` adalah kontrak stabil.
- Mockup adalah acuan visual; nilainya (warna, ukuran dock, perilaku sheet) disalin ke `app/scene/palette.ts` dan `app/styles.css`.
