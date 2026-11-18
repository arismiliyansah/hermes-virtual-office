# Desain: Hermes Virtual Office

Tanggal: 2026-11-18
Status: Disetujui pemilik (2026-11-18) — mockup acuan: `mockups/kantor-utama-v1.html` (siang/malam) dan `mockups/kantor-mobile-v1.html`

## 1. Maksud & alasan

Pemilik menjalankan satu atau lebih **Hermes Agent** (NousResearch/hermes-agent) di **VPS atau laptop yang menyala 24/7**. Memantau dan mengoperasikan agent hari ini berarti membaca terminal/log. Proyek ini mengubahnya menjadi **kantor virtual 2.5D** yang dibuka dari browser mana pun (termasuk HP): setiap agent tampak sebagai karakter yang duduk di mejanya, berpindah sesuai keadaan kerja nyata, dan bisa **dioperasikan penuh** dari kantor — chat, tugas, kanban, meeting, cron.

Aplikasi di-host di **Cloudflare** agar kantor punya URL publik yang aman dan bisa dipantau dari mana saja; Hermes tetap privat di mesin pemilik dan dihubungkan lewat **Cloudflare Tunnel dengan auth buatan sendiri** (tanpa Cloudflare Access).

Referensi yang dipelajari: `eliautobot/my-virtual-office` (2D, Hermes), `dandacompany/deskrpg` (3D, Hermes), `JuniorXcoder/hermes-virtual-office` (3D, Hermes, A2A), `W17ant/Claude-Office` (pixel isometrik), `GreenSheep01201/claw-empire` (orkestrasi multi-provider). Pola yang diadopsi dari mereka: *duty state machine*, *idle tidak memanggil model*, dan *Hermes sebagai sumber kebenaran*.

## 2. Goals

1. **Kantor 2.5D isometrik real-time** — setiap agent Hermes = karakter dengan meja sendiri; posisi dan animasinya ditentukan keadaan kerja nyata (lihat §8.6), bukan animasi acak.
2. **Operasi penuh dari kantor**:
   - Chat langsung dengan tiap agent (klik karakter → jendela chat).
   - Assign tugas ke agent.
   - **Kanban** yang tersinkron dengan task Hermes (dua arah).
   - **Meeting** multi-agent di ruang rapat dengan giliran bicara dan **notulen** otomatis.
   - Kelola **cron** tiap agent (buat, jeda, jalankan sekarang, lihat riwayat).
3. **Multi-agent** — banyak profile/agent Hermes dalam satu kantor; panggilan antar-agent (A2A) divisualkan (avatar pemanggil berjalan ke meja yang dipanggil).
4. **Akses dari mana saja** — URL publik dengan login; nyaman dibiarkan terbuka lama (tab pemantau).

## 3. Non-goals (v1)

- Bukan SaaS multi-tenant: satu kantor untuk satu pemilik. Arsitektur tidak boleh menutup jalan ke multi-office nanti.
- Bukan agnostik multi-harness: khusus Hermes Agent.
- Bukan 3D penuh, bukan aplikasi mobile native.
- Bukan pengganti terminal Hermes untuk konfigurasi low-level (install, model provider, dsb.).

## 4. Anti-goals (gagal meski teknisnya jalan)

- **Membakar token untuk ambience**: avatar idle tidak pernah memanggil model. Gerakan idle murni simulasi lokal.
- **Mengekspos gateway Hermes tanpa auth**: hostname tunnel bisa dijangkau publik, jadi setiap request wajib terverifikasi (§8.4).
- **Kantor mengarang status**: Hermes adalah sumber kebenaran untuk task, session, dan cron. Kalau Hermes bilang tidak ada pemilik suatu task, kantor menampilkan apa adanya.

## 5. Batasan

- Hermes berjalan di VPS/laptop, mungkin di belakang NAT → koneksi harus outbound dari mesin (`cloudflared`).
- Worker stateless per-request → state kantor real-time di Durable Object; persistensi di D1.
- Mesin 24/7 + tab selalu terbuka → rendering hemat resource, WebSocket dengan reconnect tangguh, Durable Object memakai hibernation agar hemat biaya.
- Versi Hermes di mesin pemilik bisa berubah → seluruh akses Hermes diisolasi dalam satu adapter (§8.5) yang diuji terhadap versi terpasang.

## 6. Pendekatan yang dipertimbangkan

| # | Pendekatan | Trade-off | Keputusan |
|---|---|---|---|
| 1 | **App di Cloudflare + `cloudflared` tunnel ke Hermes** | Standar Cloudflare; tanpa buka port; tembus NAT. Satu daemon ekstra di mesin. | **DIPILIH pemilik** |
| 2 | Bridge daemon outbound (WebSocket keluar ke Durable Object, protokol sendiri) | Tanpa konfigurasi jaringan, tapi protokol bespoke harus dibangun & dirawat | Ditolak |
| 3 | Semua di VPS (ala deskrpg) | Sederhana, tapi kantor tidak punya URL publik Cloudflare | Ditolak pemilik |

Alasan (1): pemilik sudah familier dengan Cloudflare; tunnel adalah cara standar mengekspos layanan loopback dengan aman; auth buatan sendiri tetap memungkinkan di atas tunnel (§8.4).

## 7. Keputusan pemilik (sudah final)

- Deploy aplikasi di **Cloudflare**; Hermes tetap di **VPS/laptop** sendiri.
- Konektor: **Cloudflare Tunnel (`cloudflared`)**, **auth buatan sendiri**, tanpa Cloudflare Access.
- Cakupan: **operasi penuh** (pantau + chat + tugas + kanban + meeting + cron).
- Visual: **2.5D** — diinterpretasikan sebagai **tampilan isometrik** (seperti Claude-Office); implementasi rendering diserahkan ke builder (§8.3).

## 8. Desain teknis

### 8.1 Arsitektur

```
┌────────────────────────── CLOUDFLARE ──────────────────────────┐
│ Browser (SPA SolidJS) ◄──wss──► Durable Object "OfficeHub"     │
│      │ 2.5D canvas + panel UI       │ state kantor, fan-out    │
│      └──────REST──► Worker (Hono) ──┴──► D1 (persistensi)      │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTPS + HMAC (auth sendiri)
                      ┌─────────┴──────────┐
                      │ hostname tunnel     │
                      │ (cloudflared)       │
┌─────────────────────┴─────────────────────────────────────────┐
│ VPS / laptop (24/7)                                           │
│   cloudflared ──► auth-proxy (verifikasi HMAC) ──► Hermes     │
│                                                     gateway/   │
│                                                     plugin     │
│                                                   (loopback)   │
└───────────────────────────────────────────────────────────────┘
```

### 8.2 Stack (mengikuti stack Crafyne yang sudah dikuasai pemilik)

- **Backend**: Cloudflare Workers + Hono (TypeScript).
- **Realtime**: satu Durable Object `OfficeHub` per kantor — menyimpan state agent/posisi/status di memori + SQLite DO, fan-out WebSocket ke semua browser, hibernation saat sepi.
- **Persistensi**: D1 — users, agents, layout kantor (meja/ruangan), mirror kanban, meetings + notulen, cron cache, audit log.
- **Frontend**: SPA SolidJS + Tailwind, disajikan via Workers Static Assets.

### 8.3 Rendering 2.5D (keputusan builder)

- Proyeksi **isometrik di Canvas 2D** (tile wajik rasio 2:1), sprite pixel-art, kamera pan/zoom, urutan gambar berdasarkan depth.
- Scene (lantai, meja, karakter) di canvas; **panel UI** (chat, kanban, profil, cron, meeting) di DOM SolidJS — lebih mudah diakses dan dibuat responsif untuk HP.
- Opsi cadangan bila jumlah sprite/animasi membebani: pindah ke PixiJS (WebGL) tanpa mengubah arsitektur state. Keputusan akhir saat implementasi, default Canvas 2D.
- **Kontrol tampilan**: pan (drag satu jari/mouse), zoom (wheel, cubit dua jari, tombol −/+, clamp 0.6–2.5×), dan **rotate 4 arah kelipatan 90°** (tombol). Rotasi dilakukan di level koordinat grid — bukan memutar canvas — agar sprite/avatar tetap tegak. Preferensi tampilan terakhir (zoom/rotasi/posisi) disimpan per-browser.
- Aset sprite: pack CC0 atau hasil generate; disimpan sebagai static assets.
- **Tema siang/malam**: dua palet scene (siang hangat terang; malam gelap hangat dengan layar monitor dan lampu meja sebagai sumber cahaya — bukan hitam pekat). Default mengikuti preferensi OS (`prefers-color-scheme`), bisa di-toggle manual dari top bar; pilihan tersimpan di profil ringan per-browser.

Sketsa tampilan:

```
            ╱‾‾‾‾‾‾╲___ RUANG MEETING ___╱‾‾‾‾╲
           ╱  meja ◇   meja ◇   meja ◇        ╲
     LOBBY│   [A]💻    [B]☕    [C]💻   ◇ sofa │
           ╲   meja ◇   meja ◇   meja ◇       ╱
            ╲___[D]💻___[E]🚶___[F]💻________╱
   ┌─────────────────────┐ ┌────────────────────────┐
   │ Chat: Agent B       │ │ Kanban (sync Hermes)   │
   │ "lagi refactor..."  │ │ To do │ Doing │ Review │
   └─────────────────────┘ └────────────────────────┘
```

### 8.4 Auth buatan sendiri (tanpa Cloudflare Access)

Dua lapis, keduanya mengikuti pola yang sudah dipakai pemilik di Crafyne:

1. **User → kantor**: login email/password + OAuth (Google/GitHub); sesi cookie HMAC dengan prefiks `__Host-`, host-only. Semua HTTP (`/api/*`) dan upgrade WebSocket memerlukan sesi.
2. **Worker → Hermes lewat tunnel**: hostname tunnel bersifat publik, jadi setiap request ditandatangani **HMAC-SHA256** (secret bersama + timestamp + nonce, toleransi jam ±5 menit, nonce anti-replay). Verifikasi dilakukan **auth-proxy kecil di mesin** (satu proses Node/Bun kecil) yang meneruskan ke gateway Hermes di loopback. Secret disimpan sebagai Worker secret dan file lokal di mesin; tidak pernah masuk D1/repo.
   - Catatan builder: bila gateway/plugin Hermes versi terpasang sudah punya mekanisme auth yang bisa dipakai, auth-proxy boleh digantikan oleh mekanisme itu — dicatat keputusannya saat implementasi.

Rate limiting di Worker untuk endpoint yang meneruskan ke tunnel.

### 8.5 Integrasi Hermes (adapter `HermesClient`)

Semua akses ke Hermes lewat satu modul adapter di Worker. Permukaan yang dibutuhkan (berdasarkan dokumentasi/deskrpg/hermes-virtual-office — **pemetaan endpoint persis adalah recon builder** terhadap versi Hermes terpasang, kemungkinan lewat plugin Hermes seperti yang dipakai deskrpg):

- Daftar profile/agent (nama, SOUL.md, status).
- Kirim pesan ke session agent + baca transkrip session (streaming bila tersedia).
- Daftar & ubah task (untuk kanban) — dua arah.
- Cron: daftar, buat dari blueprint, jeda/lanjut, jalankan sekarang, riwayat run.
- A2A: agent cards + riwayat panggilan antar-agent (untuk visual jalan-ke-meja).
- Event: bila gateway menyediakan WebSocket/webhook, pakai itu; jika tidak, polling berkala lewat tunnel dengan interval adaptif.

Adapter menormalisasi jawaban Hermes ke model internal kantor dan **tidak pernah mengarang** data yang Hermes tidak punya (tampilkan `null` apa adanya).

### 8.6 Duty state machine (posisi & animasi avatar)

Prioritas ketat (ditinggi ke rendah); keadaan lebih tinggi selalu mengalahkan yang lebih rendah:

1. `meeting` — sedang di ruang rapat.
2. `a2a` — sedang memanggil/dipanggil agent lain (berjalan ke meja lawan).
3. `desk` — punya task aktif, chat live, atau cron run → duduk bekerja di meja.
4. `review` — berjalan memeriksa hasil kerja agent lain.
5. `idle` — benar-benar bebas → santai di zona lounge; **tanpa panggilan model**.

Sumber perubahan state: event/status dari `HermesClient` (§8.5), bukan timer acak.

### 8.7 Fitur operasi

- **Chat**: klik avatar → panel chat → pesan dikirim sebagai session baru/lanjutan lewat gateway; balasan distream ke panel.
- **Kanban**: papan To do / Doing / Review / Done di D1, tersinkron dua arah dengan task Hermes; kartu punya pemilik (avatar), deskripsi, dan tautan ke hasil.
- **Meeting**: pilih peserta → avatar berjalan ke ruang rapat → OfficeHub mengorkestrasi giliran bicara lewat gateway → agent "sekretaris" menulis notulen → tersimpan di D1 dan bisa diekspor.
- **Cron**: panel per-agent menampilkan jadwal Hermes-nya; aksi buat/jeda/lanjut/jalankan diteruskan lewat adapter.
- **Assign tugas**: dari kanban atau dari chat; selalu tercermin sebagai task Hermes.

### 8.8 Keamanan & privasi

- Cookie sesi `__Host-`, HttpOnly, SameSite; CSRF token untuk mutasi.
- HMAC tunnel (§8.4) + rate limit; nonce anti-replay disimpan sementara di DO/KV.
- Tidak ada secret Hermes/model yang disimpan di D1; satu-satunya kredensial adalah HMAC secret tunnel (Worker secret + file lokal mesin).
- Log audit di D1 untuk aksi mutasi (assign, ubah cron, dsb.).

## 9. Yang diserahkan ke builder

- Pemetaan endpoint/plugin Hermes versi terpasang (§8.5) dan keputusan auth-proxy vs auth bawaan gateway (§8.4).
- Pembuatan/pengadaan aset sprite pixel-art (CC0 atau generate).
- Detail protokol event internal antara Worker, DO, dan SPA.
- Pemilihan final Canvas 2D vs PixiJS berdasarkan beban nyata.

## 10. Risiko utama

1. **API Hermes berubah antar versi** → mitigasi: adapter terisolasi + uji kontrak terhadap versi terpasang; pin versi Hermes yang didukung di README.
2. **Laptop di belakang NAT rumah yang sering putus** → mitigasi: `cloudflared` sebagai service dengan auto-restart; indikator "koneksi mesin terputus" yang jelas di UI.
3. **Biaya Durable Object** → mitigasi: hibernation, satu DO per kantor, batasi frekuensi broadcast.

## 11. Hasil builder check (2026-11-18) — keputusan builder, menunggu konfirmasi pemilik

1. **Satu mesin dulu.** v1 mengasumsikan satu mesin/gateway Hermes ("utama"). Skema D1 tetap menaruh `machine_id` pada tabel `agents` (default `'main'`) agar penambahan mesin kedua nanti bukan migrasi besar.
2. **Akun tunggal, registrasi tertutup.** v1: satu akun pemilik yang di-seed, login email/password saja; registrasi publik tidak ada; OAuth Google/GitHub ditunda pasca-v1. Berbagi kantor ke pengguna lain = pasca-v1.
3. **Layout tetap.** v1: denah kantor dari seed/config; agent baru otomatis menempati meja kosong; kalau penuh, masuk zona hotdesk. Editor layout drag-and-drop = pasca-v1.
4. **Kanban tanpa kartu lokal.** Setiap kartu = task Hermes (anti-goal §4). Konflik sinkron: Hermes selalu menang. Kolom "Review" dipetakan ke status Hermes bila ada; bila tidak ada, disimpan sebagai label pada task Hermes. Pemetaan status persis = recon builder.
5. **Sekretaris meeting = agent yang sudah ada**, ditunjuk lewat UI (default: agent pertama berperan manager); bukan profile khusus, bukan prasyarat instalasi. Meeting butuh ≥2 agent; bila kurang, fitur tampil nonaktif dengan penjelasan cara menambah agent.
