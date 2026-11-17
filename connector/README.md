# connector/auth-proxy

Proses kecil tanpa dependensi (Node ≥ 22) yang duduk di mesin pemilik, di belakang
`cloudflared`, untuk memverifikasi request bertanda tangan HMAC dari Worker sebelum
diteruskan ke gateway Hermes di loopback.

```
Worker ──HMAC──► cloudflared ──► auth-proxy :8787 ──► Hermes :8788
```

## Menjalankan

```bash
HVO_HMAC_SECRET=... node connector/auth-proxy.mjs
```

Secret harus sama persis dengan secret yang dipakai Worker untuk menandatangani request.
Jangan commit nilainya; simpan di environment service atau file yang hanya bisa dibaca
pemilik.

Butuh Node ≥ 22. Tidak ada `npm install`.

## Environment

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `HVO_HMAC_SECRET` | ya | — | Secret HMAC-SHA256 bersama dengan Worker. Proses keluar dengan exit 1 bila kosong. |
| `HERMES_UPSTREAM` | tidak | `http://127.0.0.1:8788` | Base URL gateway Hermes. Path pada URL ini dipakai sebagai prefiks. |
| `PORT` | tidak | `8787` | Port listen. |
| `HVO_HOST` | tidak | `127.0.0.1` | Alamat listen. Biarkan loopback karena `cloudflared` berjalan di mesin yang sama. |
| `HVO_MAX_BODY_BYTES` | tidak | `26214400` (25 MiB) | Batas body request; lebih dari ini dijawab `413`. Body harus dibaca utuh sebelum bisa diverifikasi, jadi batas ini mencegah pemakaian memori tanpa batas. |
| `HVO_UPSTREAM_TIMEOUT_MS` | tidak | `30000` (30 dtk) | Batas diam (idle) socket ke Hermes. Lewat batas ini request upstream di-destroy; bila respons belum dimulai klien menerima `504`. |

## Format tanda tangan

Sama dengan `src/sign.ts` di Worker (implementasi verifikasi di sini ditulis ulang
sendiri memakai `node:crypto`, bukan mengimpor file TypeScript tersebut):

```
METHOD \n PATHNAME \n TIMESTAMP \n NONCE \n SHA256HEX(BODY)
```

lalu di-HMAC-SHA256 dengan `HVO_HMAC_SECRET`, hasilnya hex huruf kecil.

- `METHOD` persis seperti diterima (huruf besar).
- `PATHNAME` hanya path, **tanpa query string**; query tetap ikut diteruskan ke upstream.
- `TIMESTAMP` epoch detik.
- `BODY` byte mentah request, di-hash SHA-256.

Header yang diharapkan: `x-hvo-timestamp`, `x-hvo-nonce`, `x-hvo-signature`.

## Perilaku verifikasi

1. Timestamp wajib bilangan bulat dan berada dalam ±300 detik dari jam mesin. Jam mesin
   harus sinkron (NTP); selisih di luar itu ditolak `401 stale_timestamp`.
2. Signature dibandingkan dengan `crypto.timingSafeEqual` setelah panjangnya dicek.
3. Nonce harus belum pernah dipakai. Nonce disimpan 600 detik lalu dibersihkan berkala.
   Nonce baru dicatat **setelah** signature valid, sehingga request tanpa signature sah
   tidak bisa memenuhi cache. Replay dijawab `401 replayed_nonce`.
4. Semua kegagalan verifikasi dijawab `401` dengan body JSON `{"error":"unauthorized","reason":"..."}`.

Request yang lolos diteruskan apa adanya: method, path + query, dan body byte mentah.
Header `x-hvo-*` dibuang sebelum diteruskan. Header hop-by-hop juga dibuang. Status,
header, dan body respons upstream dikembalikan tanpa diubah (body di-stream). Bila
upstream tidak bisa dihubungi, proxy menjawab `502`. Bila upstream diam melebihi
`HVO_UPSTREAM_TIMEOUT_MS` sebelum mengirim respons, request upstream di-destroy dan klien
menerima `504`; bila timeout terjadi saat body respons sedang di-stream, koneksi klien
ditutup. Klien yang memutus koneksi (abort/timeout di sisi pemanggil) juga menyebabkan
request dan respons upstream di-destroy, sehingga tidak ada socket yang tertinggal.

## Menjalankan test

```bash
node --test connector/auth-proxy.test.mjs
```

Test memakai upstream palsu yang menggemakan method, path, dan body, lalu menguji request
valid, timestamp -301/+301 detik, replay nonce, signature salah, signature yang keliru
memasukkan query string, body yang diubah, header yang hilang, klien abort saat upstream
hang, dan timeout upstream (`504` + socket upstream ditutup).

## systemd (Linux)

`/etc/systemd/system/hvo-auth-proxy.service`:

```ini
[Unit]
Description=Hermes Virtual Office auth proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/hermes-virtual-office
EnvironmentFile=/etc/hvo-auth-proxy.env
ExecStart=/usr/bin/node /opt/hermes-virtual-office/connector/auth-proxy.mjs
Restart=always
RestartSec=2
# Proses hanya butuh secret dan jaringan loopback.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
```

File environment `/etc/hvo-auth-proxy.env` (mode `0600`, milik root/user service):

```bash
HVO_HMAC_SECRET=...
HERMES_UPSTREAM=http://127.0.0.1:8788
PORT=8787
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hvo-auth-proxy
sudo systemctl status hvo-auth-proxy
```

## launchd (macOS)

`~/Library/LaunchAgents/com.crafyne.hvo-auth-proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.crafyne.hvo-auth-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/OWNER/hermes-virtual-office/connector/auth-proxy.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/OWNER/hermes-virtual-office</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HVO_HMAC_SECRET</key>
    <string>ISI_SECRET_DI_SINI</string>
    <key>HERMES_UPSTREAM</key>
    <string>http://127.0.0.1:8788</string>
    <key>PORT</key>
    <string>8787</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/hvo-auth-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hvo-auth-proxy.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.crafyne.hvo-auth-proxy.plist
launchctl print gui/$(id -u)/com.crafyne.hvo-auth-proxy
```

Plist berisi secret: batasi permission (`chmod 600`) dan jangan simpan di dalam repo.
Alternatif yang lebih rapi: bungkus dengan wrapper yang membaca file secret, atau pakai
`launchd` + `EnvironmentVariables` hanya untuk nilai non-rahasia.

## cloudflared

Arahkan hostname tunnel ke proxy, bukan langsung ke Hermes:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: office.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

`cloudflared` hanya perlu koneksi keluar; tidak ada port yang dibuka ke internet.

## Catatan operasional

- Sinkronkan jam mesin (`timedatectl` / NTP). Timestamp di luar ±300 detik selalu ditolak.
- Restart proxy menghapus cache nonce. Request dengan timestamp masih dalam jendela ±300
  detik dan nonce lama secara teori bisa lolos sekali lagi setelah restart; ini konsekuensi
  dari penyimpanan nonce in-memory (sesuai desain, tanpa dependensi/state eksternal).
- Log hanya berisi baris startup/shutdown; signature dan secret tidak pernah dicetak.
