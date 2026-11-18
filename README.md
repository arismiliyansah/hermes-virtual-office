# Hermes Virtual Office

Kantor virtual isometrik untuk **Hermes Agent**: satu layar untuk melihat agent
bekerja, mengobrol dengan mereka, mengelola task dan cron, serta menjalankan meeting
yang notulennya ditulis sekretaris.

Status: **v0.1** — berfungsi untuk satu pemilik, tetapi pemetaan endpoint Hermes masih
**provisional** dan perlu recon manual terhadap instalasi nyata
(lihat [docs/hermes-api-notes.md](docs/hermes-api-notes.md)). Jangan menganggap semua
panel sudah terhubung ke API Hermes yang sebenarnya.

## Arsitektur

Aplikasi berjalan di Cloudflare; Hermes tetap di mesin pemilik dan tidak membuka port
ke internet. Cloudflare Tunnel hanya punya koneksi keluar, dan setiap request dari
Worker ditandatangani HMAC sebelum diteruskan ke gateway Hermes.

```
Browser ──HTTPS + cookie sesi──► Cloudflare Worker (Hono, SPA SolidJS)
                                      │
                                      ├─ D1: users, agents, tasks, meetings, minutes, audit
                                      └─ Durable Object OfficeHub: WebSocket hub
                                      │
                                      │ request bertanda tangan HMAC
                                      ▼
                              Cloudflare Tunnel (hostname)
                                      │
                                      ▼
                          cloudflared di mesin pemilik
                                      │
                                      ▼
                    connector/auth-proxy.mjs :8787  (verifikasi HMAC)
                                      │
                                      ▼
                         gateway Hermes :8788 (loopback)
```

Autentikasi memakai mekanisme sendiri (cookie `__Host-` bertanda tangan + CSRF),
bukan Cloudflare Access. Detail batas kepercayaan dan format tanda tangan ada di
[connector/README.md](connector/README.md).

## Prasyarat

- Node.js **≥ 22** (lihat `engines` di `package.json`)
- pnpm (versi mengikuti field `packageManager`)
- Akun Cloudflare dengan akses Workers, D1, dan Durable Objects
- Domain yang dikelola Cloudflare bila ingin memakai hostname tunnel sendiri
- Hermes Agent yang sudah terpasang dan berjalan di mesin pemilik
- `cloudflared` di mesin pemilik

## Quickstart pengembangan

```bash
pnpm install
pnpm test
pnpm exec wrangler d1 migrations apply hermes-office --local
./scripts/seed.sh
pnpm build:app
pnpm dev
```

`pnpm build:app` harus dijalankan minimal sekali sebelum `pnpm dev`, karena Worker
menyajikan aset statis dari `app/dist`. Login lokal memakai user dari seed:
`hermes@hermes.local` / `hermes-dev`.

Tanpa Hermes yang bisa dijangkau, login dan kerangka kantor tetap terbuka, tetapi
panel agent/task/cron akan menampilkan error koneksi. `wrangler.jsonc` berisi nilai
dev `dev-secret` / `dev-hmac-secret`; **jangan pernah memakai nilai itu di produksi**.

Perintah lain:

```bash
pnpm vitest run --config app/vitest.config.ts   # test SPA (happy-dom)
node --test connector/auth-proxy.test.mjs       # test connector (Node murni)
node scripts/smoke.mjs --check-config           # cek env deployment wajib
pnpm typecheck
```

## Struktur repo

```
app/          SPA SolidJS: canvas isometrik, dock, chat, kanban, meeting, cron
connector/    auth-proxy Node tanpa dependensi (verifikasi HMAC)
deploy/       contoh konfigurasi cloudflared dan unit systemd
docs/         panduan deploy, catatan API Hermes, spec, dan plan
migrations/   skema D1 (0001_init.sql, 0002_task_statuses.sql)
mockups/      mockup HTML sebagai acuan visual
scripts/      hash-password, seed, dan smoke check
src/          Worker Hono: auth, routes, Hermes client, Durable Object OfficeHub
tests/        test Worker (Vitest Workers pool) dan test Node
```

## Konfigurasi

| Sisi | Variabel | Keterangan |
| --- | --- | --- |
| Worker | `HERMES_ORIGIN` | Hostname tunnel, tanpa path (mis. `https://hermes-office.example.com`) |
| Worker | `HERMES_HMAC_SECRET` | Secret bersama untuk menandatangani request ke connector |
| Worker | `SESSION_SECRET` | Kunci tanda tangan cookie sesi |
| Connector | `HVO_HMAC_SECRET` | **Harus sama persis** dengan `HERMES_HMAC_SECRET` |
| Connector | `HERMES_UPSTREAM` | Default `http://127.0.0.1:8788` |
| Connector | `PORT` | Default `8787` |

`node scripts/smoke.mjs --check-config` memeriksa bahwa `HERMES_ORIGIN`,
`SESSION_SECRET`, dan `HVO_HMAC_SECRET` terisi; perintah ini tidak menguji nilai atau
konektivitas.

## Dokumentasi

- [Panduan deployment lengkap](docs/deploy.md) — D1, secret, tunnel, systemd, seed,
  dan checklist smoke manual
- [Catatan API Hermes](docs/hermes-api-notes.md) — endpoint provisional dan langkah
  recon manual
- [Connector auth-proxy](connector/README.md) — format HMAC, perilaku verifikasi,
  systemd/launchd
- [Spec desain](docs/superpowers/specs/2026-11-18-hermes-virtual-office-design.md)
- [Plan implementasi](docs/superpowers/plans/2026-11-18-hermes-virtual-office.md)

## Mockup

Acuan visual ada di repo dan bisa dibuka langsung di browser:

- [Kantor utama](mockups/kantor-utama-v1.html)
- [Kantor mobile](mockups/kantor-mobile-v1.html)

Warna, ukuran dock, dan perilaku sheet di SPA mengikuti nilai yang disalin dari mockup
ke `app/scene/palette.ts` dan `app/styles.css`.
