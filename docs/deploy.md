# Deployment

Panduan ini mengasumsikan aplikasi di-deploy ke Cloudflare (Worker + D1 + Durable
Object), sedangkan Hermes tetap berjalan di mesin pemilik di belakang
`cloudflared` dan `connector/auth-proxy.mjs`.

```
Browser ──► Worker (office.example.com atau *.workers.dev)
                │
                └──► https://hermes-office.example.com  (hostname tunnel)
                          │
                          ▼
                   cloudflared (mesin pemilik)
                          │
                          ▼
             auth-proxy 127.0.0.1:8787 ──► Hermes 127.0.0.1:8788
```

Dua hostname berbeda sering tertukar:

- **Hostname aplikasi** — tempat browser membuka kantor (mis. `office.example.com`
  lewat custom domain Worker, atau `<worker>.<subdomain>.workers.dev`).
- **Hostname tunnel** — hanya dipakai Worker untuk memanggil connector (mis.
  `hermes-office.example.com`). Isi hostname ini ke `HERMES_ORIGIN`.

## 0. Prasyarat

- Node.js ≥ 22 dan pnpm di mesin deploy
- `wrangler` sudah login: `pnpm exec wrangler login`
- Akun Cloudflare dengan Workers, D1, dan Durable Objects
- Hermes Agent terpasang di mesin pemilik, gateway-nya mendengarkan di loopback
  (default `http://127.0.0.1:8788`)
- `cloudflared` terpasang di mesin pemilik
- Jam mesin pemilik sinkron NTP (lihat bagian [NTP dan skew HMAC](#ntp-dan-skew-hmac))

> **Jangan pakai secret dev.** `wrangler.jsonc` berisi `dev-secret` dan
> `dev-hmac-secret` hanya untuk pengembangan lokal. Ganti keduanya sebelum deploy
> pertama dan jangan pernah menaruh nilai aslinya di repo.

## 1. Buat database D1

```bash
pnpm exec wrangler d1 create hermes-office
```

Perintah ini mencetak `database_id`. Tambahkan ke `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "hermes-office",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
]
```

## 2. Terapkan semua migrasi

Terapkan **keduanya**, berurutan: `migrations/0001_init.sql` lalu
`migrations/0002_task_statuses.sql`. Wrangler melacak migrasi yang sudah jalan, jadi
cukup jalankan perintah `migrations apply` (jangan `d1 execute` satu per satu).

```bash
# Database produksi
pnpm exec wrangler d1 migrations apply hermes-office --remote

# Database lokal untuk pengembangan
pnpm exec wrangler d1 migrations apply hermes-office --local
```

Verifikasi:

```bash
pnpm exec wrangler d1 execute hermes-office --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Tabel yang harus ada: `agents`, `audit`, `meetings`, `minutes`, `task_statuses`,
`tasks`, `users` (plus tabel internal D1).

## 3. Set secret Worker

Buat nilai acak, lalu simpan sebagai secret Worker:

```bash
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # HERMES_HMAC_SECRET

pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler secret put HERMES_HMAC_SECRET
```

`HERMES_HMAC_SECRET` **harus sama persis** dengan `HVO_HMAC_SECRET` yang dipakai
connector di mesin pemilik. Kalau berbeda, setiap request ke Hermes akan ditolak
`401 unauthorized`.

Setelah kedua secret dibuat, hapus entri `SESSION_SECRET` dan `HERMES_HMAC_SECRET`
dari blok `vars` di `wrangler.jsonc` supaya tidak ada binding ganda dan nilai dev
tidak ikut ter-deploy.

## 4. Set HERMES_ORIGIN

Edit `wrangler.jsonc` dan isi hostname tunnel (tanpa trailing slash dan tanpa path):

```jsonc
"vars": {
  "HERMES_ORIGIN": "https://hermes-office.example.com"
}
```

`HERMES_ORIGIN` bukan secret, jadi cukup sebagai var. Jangan menambahkan path
prefiks: path yang ditandatangani Worker harus sama dengan path yang diverifikasi
connector.

## 5. Build aset lalu deploy Worker

```bash
pnpm build:app
pnpm exec wrangler deploy
```

Gunakan `pnpm exec wrangler deploy` (atau `pnpm run deploy`), bukan `pnpm deploy` —
`pnpm deploy` adalah perintah bawaan pnpm, bukan script repo. `pnpm build:app` wajib
dijalankan sebelum deploy karena Worker menyajikan `app/dist`.

## 6. Siapkan cloudflared di mesin pemilik

```bash
cloudflared tunnel login
cloudflared tunnel create hermes-office
cloudflared tunnel route dns hermes-office hermes-office.example.com
```

Salin contoh konfigurasi dan sesuaikan tunnel id, credentials file, serta hostname.
`cloudflared tunnel create` menyimpan credentials di `~/.cloudflared/<tunnel-id>.json`;
salin file itu ke path yang dirujuk konfigurasi:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp deploy/cloudflared.example.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo editor /etc/cloudflared/config.yml
```

Isi pentingnya:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: hermes-office.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

**Arahkan ke `127.0.0.1:8787` (auth-proxy), bukan `127.0.0.1:8788` (Hermes).**
Tanpa proxy, siapa pun yang bisa menjangkau hostname tunnel dapat memanggil Hermes
langsung.

Jalankan sebagai service (Linux):

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

Alternatif manual untuk uji cepat: `cloudflared tunnel run hermes-office`.
Di macOS, konfigurasi biasanya di `~/.cloudflared/config.yml`.

## 7. Jalankan auth-proxy di mesin pemilik

Connector tidak punya dependensi npm; cukup Node ≥ 22 dan satu file.

```bash
sudo useradd --system --home /opt/hermes-virtual-office \
  --shell /usr/sbin/nologin hvo
sudo mkdir -p /opt/hermes-virtual-office
sudo cp -R connector /opt/hermes-virtual-office/
sudo chown -R hvo:hvo /opt/hermes-virtual-office

sudo install -m 600 -o root -g root /dev/null /etc/hvo-auth-proxy.env
sudo editor /etc/hvo-auth-proxy.env
```

Isi `/etc/hvo-auth-proxy.env`:

```bash
HVO_HMAC_SECRET=<nilai yang sama dengan HERMES_HMAC_SECRET>
HERMES_UPSTREAM=http://127.0.0.1:8788
PORT=8787
# HVO_UPSTREAM_TIMEOUT_MS=30000
```

Pasang unit systemd contoh:

```bash
sudo cp deploy/hermes-auth-proxy.service /etc/systemd/system/hvo-auth-proxy.service
sudo systemctl daemon-reload
sudo systemctl enable --now hvo-auth-proxy
sudo systemctl status hvo-auth-proxy
```

Unit contoh memakai `User=hvo` (non-root), `EnvironmentFile=`, dan
`Restart=always`. Jika Node tidak ada di `/usr/bin/node`, sesuaikan `ExecStart`.
Uji dari mesin itu sendiri:

```bash
curl -i http://127.0.0.1:8787/agents
# harus 401 unauthorized: request tanpa tanda tangan HMAC
```

`401` di sini benar: artinya proxy hidup dan menolak request tanpa signature. `502`
berarti proxy tidak bisa menghubungi `HERMES_UPSTREAM`.

## 8. Seed akun owner

Hanya ada satu akun owner; registrasi publik tidak tersedia. Seed default memakai
`hermes@hermes.local` / `hermes-dev` — ganti sebelum dipakai sungguhan.

```bash
# 1. Buat hash password baru
node scripts/hash-password.mjs 'password-yang-kuat'

# 2. Salin output pbkdf2$... ke password_hash di scripts/seed.sql
#    (dan ubah email bila perlu)

# 3. Terapkan ke database produksi
./scripts/seed.sh --remote
```

Mode `--remote` meneruskan ke database D1 produksi:

```bash
pnpm exec wrangler d1 execute hermes-office --remote --file=scripts/seed.sql
```

Untuk pengembangan lokal, jalankan tanpa opsi (default lokal):

```bash
./scripts/seed.sh
# sama dengan: pnpm exec wrangler d1 execute hermes-office --local --file=scripts/seed.sql
```

`users.id` bersifat tetap, jadi seed ulang setelah baris pertama ada akan gagal
dengan `UNIQUE constraint`. Hapus baris lama lebih dulu bila memang perlu reseed.

## 9. Recon API Hermes

Sebelum menganggap panel berfungsi, lakukan recon manual terhadap instalasi Hermes.
Ikuti langkah di [docs/hermes-api-notes.md](hermes-api-notes.md). Ringkasnya:

1. Temukan gateway Hermes dan pastikan HTTP API-nya aktif di `127.0.0.1:8788`.
2. Uji jalur penuh lewat auth-proxy: request tanpa HMAC → `401`, request bertanda
   tangan benar → diteruskan.
3. Cocokkan setiap endpoint provisional (`/agents`, `/tasks`, `/crons`,
   `/agents/:id/messages`, `/a2a/call`) dengan path dan bentuk respons nyata.
4. Bila path/response berbeda, ubah internal `HermesClient` di `src/hermes.ts` —
   jangan ubah method public-nya — lalu perbarui catatan dan test.

Endpoint di dokumen tersebut **belum diverifikasi** terhadap Hermes sungguhan.

## 10. Smoke check konfigurasi

Dari repo (nama variabel saja; nilai tidak dicetak):

```bash
export HERMES_ORIGIN=https://hermes-office.example.com
export SESSION_SECRET=<session-secret>
export HVO_HMAC_SECRET=<hmac-secret-yang-sama-dengan-worker>
node scripts/smoke.mjs --check-config
```

- Exit `0`, output `config ok` → ketiga env terisi.
- Exit `1` → daftar variabel yang kosong dicetak ke stderr.

Perintah ini hanya memeriksa keberadaan/isi nama env. Ia tidak menguji apakah secret
cocok dengan Worker, apakah tunnel hidup, atau apakah D1 sudah dimigrasikan.

Jalankan juga suite:

```bash
pnpm test
pnpm typecheck
node --test connector/auth-proxy.test.mjs
```

## Checklist smoke manual

Lakukan setelah deploy pertama, idealnya dari jaringan seluler:

- [ ] **Login dari HP.** Buka hostname aplikasi di browser ponsel, login dengan akun
      hasil seed. Halaman kantor tampil, dock bisa dibuka, dan sesi bertahan setelah
      refresh (cookie `__Host-` hanya dikirim lewat HTTPS).
- [ ] **Kegagalan aksi Hermes saat tunnel dimatikan.** Status Topbar berasal dari
      WebSocket browser→Worker (`/api/ws` ke OfficeHub), bukan dari tunnel Hermes.
      Karena itu mematikan `cloudflared` **tidak** mengubah Topbar: selama Worker
      hidup, Topbar tetap **terhubung**. Untuk menguji jalur Hermes, matikan tunnel
      (`sudo systemctl stop cloudflared`), lalu kirim chat, mulai meeting, atau
      jalankan cron. Panel harus menampilkan pesan kegagalan; API Worker membalas
      `502 hermes_unavailable` dan aplikasi tidak crash. Nyalakan kembali tunnel,
      ulangi aksi yang sama, dan pastikan berhasil. Reconnect WebSocket otomatis
      (backoff maksimum 15 detik) hanya berlaku bila koneksi browser–Worker yang
      putus, bukan tunnel.
- [ ] **Tema malam.** Tekan **Malam** di Topbar. Palet scene berubah, pilihan bertahan
      setelah refresh, dan teks tetap terbaca.
- [ ] **Meeting dengan ≥ 2 agent.** Buka tab Meeting, pilih minimal dua agent, isi
      judul, mulai rapat. Giliran bicara muncul dan notulen tersimpan.
- [ ] **Setujui kartu kanban.** Kartu berstatus `review` (atau dengan label kantor
      yang belum `done`) menampilkan tombol **Setujui**. Klik → kartu pindah ke Done
      dan tombol hilang.
- [ ] Opsional: toggle cron dan tombol **Jalankan** menampilkan `runId`; chat ke satu
      agent menerima balasan.

## NTP dan skew HMAC

Timestamp request hanya diterima dalam **±300 detik** dari jam mesin. Jam yang
melayang akan menghasilkan `401 stale_timestamp`.

```bash
timedatectl status          # Linux
sudo timedatectl set-ntp true
# macOS: System Settings → General → Date & Time → set automatically
```

Cloudflare Worker memakai jam Cloudflare; yang perlu disinkronkan adalah **mesin
pemilik** yang menjalankan connector.

## Troubleshooting

| Gejala | Kemungkinan penyebab |
| --- | --- |
| `401 stale_timestamp` | Jam mesin tidak sinkron (NTP), atau selisih > 300 detik |
| `401 unauthorized` / signature salah | `HVO_HMAC_SECRET` ≠ `HERMES_HMAC_SECRET`, ada spasi/trailing newline, atau `HERMES_ORIGIN` memakai path prefiks |
| `502` dari proxy | Gateway Hermes tidak hidup di `HERMES_UPSTREAM` |
| `504` | Upstream diam melebihi `HVO_UPSTREAM_TIMEOUT_MS`; naikkan bila perlu |
| `404` untuk aset/SPA | `pnpm build:app` belum dijalankan sebelum deploy, atau `app/dist` kosong |
| Login selalu gagal | Seed belum diterapkan, atau seed masuk ke database lokal sementara Worker memakai D1 remote |
| WebSocket langsung `401` | Cookie sesi tidak ada/kedaluwarsa; login ulang lewat HTTPS |
| `duplicate binding` saat deploy | Nama yang sama ada di `vars` dan sebagai secret; hapus dari `vars` |

## Catatan keamanan

- Ganti `dev-secret` dan `dev-hmac-secret`; gunakan nilai acak dari `openssl rand`.
- Jangan commit `.env`, file secret connector, atau credentials tunnel.
- Biarkan connector listen di loopback (`HVO_HOST=127.0.0.1`, default). Hanya
  `cloudflared` yang boleh menjangkaunya.
- Jangan arahkan ingress tunnel langsung ke port Hermes.
- Autentikasi aplikasi adalah session cookie milik sendiri, bukan Cloudflare Access;
  tidak ada lapisan identitas Cloudflare di depan Worker.
