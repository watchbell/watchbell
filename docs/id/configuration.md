# Konfigurasi

English: [../configuration.md](../configuration.md)

Watchbell membaca pengaturannya dari `app/.env`. Installer membuat file ini dengan nilai default yang aman dan secret
baru; [`app/.env.example`](../../app/.env.example) berisi setiap key beserta komentarnya. Restart Watchbell setelah
Anda mengubah file ini.

- [Mengedit app/.env](#mengedit-appenv)
- [Pengaturan inti](#pengaturan-inti)
- [Pengaturan opsional](#pengaturan-opsional)
- [Pengaturan khusus cloud](#pengaturan-khusus-cloud)
- [Zona waktu](#zona-waktu)
- [Mengganti port](#mengganti-port)
- [Akses LAN](#akses-lan)
- [Di belakang reverse proxy](#di-belakang-reverse-proxy)
- [Memakai Postgres sendiri](#memakai-postgres-sendiri)

## Mengedit app/.env

- Satu `KEY=value` per baris, tanpa spasi di sekitar `=`. Tanda kutip tidak diperlukan.
- File ini berisi secret. Pastikan hanya Anda yang bisa membacanya (installer Linux men-set mode 600; installer Windows
  membatasinya ke user Windows Anda), jangan pernah di-commit, dan simpan salinannya di tempat aman (lihat
  [Backup](backups.md)).
- Jangan pakai `app/.env.local` untuk instalasi self-hosted. Di bawah `npm run start:selfhost`, service Linux, dan task
  Windows, nilai dari `app/.env` sudah ada di environment saat Next.js mulai, jadi `app/.env.local` hanya bisa
  menambahkan key yang tidak ada di `app/.env`; ia tidak bisa mengubahnya. Saat build (`npm run build`) justru
  sebaliknya: Next.js membiarkan `app/.env.local` menang untuk nilai `NEXT_PUBLIC_*`, jadi kedua file bisa saling
  bertentangan. Simpan semua pengaturan di `app/.env`.
- Restart setelah perubahan: `systemctl --user restart watchbell` (service Linux); `npm run stop:selfhost` di `app\`
  lalu `Start-ScheduledTask Watchbell` (task Windows); atau Ctrl+C lalu `npm run start:selfhost` (manual).
- Service, Scheduled Task, dan `npm run start:selfhost` semuanya membaca `app/.env`. Saat Anda menjalankan Watchbell
  secara manual, pengaturan yang diberikan di shell menang atas isi file (lihat
  [Instalasi](install.md#menjalankan-dan-menghentikan)).
- `npm run reset-login` sama sekali tidak membaca `app/.env`. Kalau Anda mengubah `WATCHBELL_DATA_DIR` atau
  `DATABASE_URL`, set keduanya di shell saat menjalankannya.

## Pengaturan inti

Installer menulis semua pengaturan ini.

Pengaturan yang namanya diawali `WATCHBELL_` (`WATCHBELL_MODE`, `WATCHBELL_DATA_DIR`, dan lainnya di bawah) dulu
bernama `WATCHPOST_*` saat produk ini masih bernama Watchpost. Watchbell membaca nama baru lebih dulu dan kembali ke
nama lama kalau tidak ada, jadi `app/.env` dari instalasi lama tetap bekerja tanpa perubahan apa pun; installer tidak
menambahkan baris kedua dengan nama baru kalau baris dengan nama lama sudah ada.

| Key | Default | Fungsinya |
|---|---|---|
| `WATCHBELL_MODE` | `selfhost` | Mode runtime. `selfhost` berarti satu mesin dengan database lokal dan scheduler bawaan. (`cloud` adalah deployment hosted Vercel + Supabase dan `demo` adalah sandbox read-only; keduanya bukan untuk instalasi self-hosted.) |
| `DATABASE_URL` | `pglite:` | Database PGlite lokal di `WATCHBELL_DATA_DIR`. Lihat [Memakai Postgres sendiri](#memakai-postgres-sendiri). |
| `WATCHBELL_DATA_DIR` | `./data` | Folder untuk database dan kode setup, relatif terhadap `app/`. Backup folder ini. |
| `HOST` | `127.0.0.1` | Network interface tempat Watchbell mendengarkan. `127.0.0.1` berarti hanya mesin ini. Lihat [Akses LAN](#akses-lan). |
| `PORT` | `3100` | Port tempat Watchbell mendengarkan. |
| `SITE_URL` | `http://localhost:3100` | Alamat yang Anda buka untuk mengakses Watchbell. Dipakai untuk link di alert, status page dan badge, contoh MCP dan API, serta sebagai dasar alamat redirect OAuth. Harus sesuai dengan `HOST` dan `PORT` dari sudut pandang pengguna. |
| `OPS_ENCRYPTION_KEY` | dibuat otomatis | 32 byte acak, base64. Mengenkripsi setiap token, webhook, dan secret authenticator yang tersimpan. **Jangan pernah mengubah atau menghilangkannya**: key yang berbeda membuat semuanya tidak bisa dibaca. Buat secara manual dengan `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |
| `COLLECTOR_SECRET` | dibuat otomatis | Minimal 32 karakter. Mengizinkan scheduler dari luar memanggil `POST /api/collect` dengan `Authorization: Bearer <secret>`. Scheduler bawaan tidak membutuhkannya, tetapi tanpa ini route tersebut tetap mati. |
| `CRON_SECRET` | dibuat otomatis | Minimal 16 karakter. Mengizinkan `GET /api/daily` menjalankan job harian dengan `Authorization: Bearer <secret>`; auto-action "Rerun daily job" memakainya. |

Buat `COLLECTOR_SECRET` atau `CRON_SECRET` baru dengan
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Berbeda dengan encryption key,
keduanya boleh diganti kapan saja.

## Pengaturan opsional

| Key | Fungsinya |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram Anda dari @BotFather. Mengaktifkan channel Telegram (lihat [Notifikasi](notifications.md#telegram)). |
| `RESEND_API_KEY` | API key Resend dengan akses sending (diawali `re_`), untuk ringkasan email harian. |
| `DIGEST_FROM` | Alamat From untuk ringkasan email, di domain yang sudah diverifikasi di Resend, misalnya `Watchbell <noreply@your-domain.example>`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client milik Anda sendiri, untuk [Backup](backups.md#membuat-google-oauth-client-sendiri) dan untuk membuat project Firebase. |
| `DAILY_HEARTBEAT_TOKEN` | Token heartbeat yang Anda tambahkan di Uptime (periode 1 hari, grace 6 jam). Job harian lalu melakukan ping ke sana, jadi job harian yang tidak pernah berjalan memicu alert seperti job lain yang terlewat. |
| `WATCHBELL_TRUSTED_PROXY_HOPS` | Berapa banyak reverse proxy di depan Watchbell yang menambahkan entri `X-Forwarded-For` yang tepercaya. Biarkan kosong kalau tidak ada proxy. Lihat [Di belakang reverse proxy](#di-belakang-reverse-proxy). |
| `WATCHBELL_MIGRATIONS_DIR` | Folder berisi migrasi database, hanya diperlukan kalau Anda menjalankan server dari luar `app/` (default `drizzle-selfhost`). |
| `WATCHBELL_TIMEZONE` | Zona waktu untuk setiap waktu yang ditampilkan dan dikirim, job harian, dan ringkasan email, sebagai nama IANA seperti `Europe/Berlin`. Kalau tidak di-set, artinya `Asia/Jakarta` (WIB). Lihat [Zona waktu](#zona-waktu). |
| `WATCHBELL_ALLOW_REMOTE_DB` | Set ke `1` untuk mengizinkan Postgres remote di `DATABASE_URL` yang biasanya ditolak Watchbell (database Supabase hosted, atau alamat yang tidak bisa diperiksanya). |
| `WATCHBELL_COLLECT_MIN_GAP_MIN` | Jeda paling sedikit (menit) antara dua run yang dimulai scheduler luar lewat `POST /api/collect` (default `10`, `0` mematikannya). Panggilan yang datang lebih cepat dari itu setelah run terakhir langsung dijawab tanpa menjalankan apa pun, jadi jadwal yang tidak sengaja di-set tiap menit tidak menghabiskan CPU paket gratis. Refresh now dan scheduler bawaan tidak dibatasi. |

Setiap pengaturan notifikasi berdiri sendiri: pengaturan yang tidak ada hanya mematikan channel-nya, dengan catatan di
Alerts › Notifications.

## Pengaturan khusus cloud

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `OWNER_EMAIL`,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `QSTASH_CURRENT_SIGNING_KEY`, dan `QSTASH_NEXT_SIGNING_KEY` milik mode `cloud` yang
hosted. Biarkan kosong di instalasi self-hosted. Watchbell hanya memeriksanya kalau Anda men-set-nya.

Di Vercel, Watchbell membatasi request `/api/ping/*`, `/api/v1/*`, dan sign-in per alamat di memori, per instance
server, sebelum menyentuh database. Kalau paket Vercel Anda punya aturan rate limit Firewall, Anda bisa menambahkannya
juga (opsional), misalnya 120 request per menit per IP untuk `/api/ping/` dan `/api/v1/`, dan 10 per menit untuk
`POST /signin`.

## Zona waktu

Watchbell menampilkan dan mengirim setiap waktu dalam satu zona waktu, apa pun pengaturan komputer tempatnya berjalan,
dan menjalankan jadwalnya sendiri menurut jam zona itu: job harian pukul 03:00 dan ringkasan email pukul 07:00.

- Set dengan `WATCHBELL_TIMEZONE` di `app/.env` (atau `~/.watchbell/.env` untuk paket npm), sebagai nama IANA:
  `Europe/Berlin`, `America/New_York`, `Asia/Kolkata`, `UTC`. Restart Watchbell setelah mengubahnya. Settings ›
  Collector menampilkan zona yang sedang dipakai.
- Installer dan npm CLI menulis zona komputer ini ke `.env` yang **baru**. Keduanya tidak pernah menambahkannya ke
  `.env` yang sudah ada, jadi instalasi dari sebelum 1.1 tetap memakai default. `.env` yang dibuat manual dari
  `app/.env.example` berisi baris ini dalam keadaan di-comment, jadi tetap memakai default sampai Anda men-set-nya.
- Kalau tidak di-set, nilainya `Asia/Jakarta`, ditampilkan sebagai WIB. Nama yang tidak dikenal Watchbell (salah ketik
  seperti `Asia/Jakata`), offset (`+07:00`; pakai nama IANA, atau `Etc/GMT-7` untuk UTC+7 yang tetap), atau singkatan
  (`CET`, `IST`, `BST`: tulis `Europe/Berlin`, `Asia/Kolkata`, `Europe/London`) juga berarti `Asia/Jakarta`, dengan
  satu peringatan di log saat Watchbell mulai dan catatan di Settings › Collector.
- Waktu diberi label `WIB` untuk `Asia/Jakarta`, selain itu dengan nama pendek zonanya (`CET`/`CEST`, `EDT`,
  `GMT+5:30`). Teks tentang waktu secara umum menyebut nama zonanya ("Times in Europe/Berlin", "Cleaned daily at
  03:00 Europe/Berlin").
- Daylight saving diikuti: job harian dan ringkasan email berjalan pukul 03:00 dan 07:00 menurut jam lokal, juga pada
  hari pergantian jam, dan maintenance window mingguan tetap pada jam lokalnya (10:00 tetap 10:00).
- Hari adalah hari lokal: bar uptime, hitungan "today", dan backup bulanan dimulai pada tengah malam lokal. Kalau Anda
  mengganti zona di kemudian hari, hari yang sudah di-rollup tetap memakai batas yang dipakai saat dihitung; hanya hari
  baru yang mengikuti zona baru. Job harian dan ringkasan email tidak berjalan dua kali pada hari itu, bahkan saat
  tanggal di zona baru lebih awal daripada zona lama. Di zona dengan offset setengah jam (`Asia/Kolkata`), satu jam
  pengecekan yang sudah di-rollup dihitung pada hari jam itu dimulai.
- Mode `cloud` yang hosted menjadwalkan job hariannya dengan Vercel Cron, yang selalu berjalan dalam UTC
  (`0 20 * * *`, 03:00 WIB). Di sana zona waktu mengubah apa yang ditampilkan dan dikirim, bukan kapan job harian
  berjalan; console menampilkan job harian pukul 20:00 UTC dalam zona Anda (misalnya "21:00 CET"). Set variabelnya di
  Vercel lalu redeploy.

## Mengganti port

1. Di `app/.env`, ubah `PORT` dan `SITE_URL` sekaligus:

   ```bash
   PORT=3200
   SITE_URL=http://localhost:3200
   ```

2. Restart Watchbell.
3. Kalau Anda memakai backup Google Drive, tambahkan redirect URI yang baru ke Google OAuth client Anda (lihat
   [Backup](backups.md#membuat-google-oauth-client-sendiri)).

Opsi `--port` milik installer (`-Port` di Windows) melakukan hal yang sama untuk instalasi baru.

## Akses LAN

Secara default Watchbell mendengarkan di `127.0.0.1`, jadi hanya mesin tempatnya berjalan yang bisa membukanya. Untuk
membukanya dari ponsel atau komputer lain di jaringan yang sama:

1. Di `app/.env`:

   ```bash
   HOST=0.0.0.0
   SITE_URL=http://192.168.1.20:3100
   ```

   Pakai alamat mesin itu sendiri di jaringan Anda, bukan `192.168.1.20` (`ip addr` di Linux, `ipconfig` di Windows,
   System Settings › Network di macOS). Alamat tetap, yang di-set di router Anda, membuat link di alert tetap bisa
   dipakai.
2. Restart Watchbell.
3. Izinkan port-nya sendiri di firewall mesin itu kalau firewall memblokirnya (misalnya `sudo ufw allow 3100/tcp` di
   Ubuntu, atau izinkan Node.js saat Windows bertanya). Installer tidak pernah mengubah firewall.

Pahami risikonya sebelum Anda melakukan ini:

- **Siapa pun di jaringan itu bisa menjangkau Watchbell**: halaman sign-in, halaman setup kalau belum ada owner, API,
  ping heartbeat, dan status page. Pakai hanya di jaringan yang Anda percayai, jangan pernah di Wi-Fi publik.
  Selesaikan setup pertama kali sebelum Anda membukanya.
- **Koneksinya HTTP biasa**: password, kode authenticator, dan cookie session melewati jaringan tanpa enkripsi, jadi
  siapa pun di jaringan yang sama bisa membacanya. Untuk apa pun di luar jaringan rumah, tetap pakai `HOST=127.0.0.1`
  dan pasang HTTPS reverse proxy di depannya (bagian berikutnya).
- Google hanya menerima alamat redirect `http://` biasa untuk `localhost`, jadi Google Drive tidak bisa dihubungkan
  lewat alamat `http://192.168…`. Hubungkan sekali dari mesin itu sendiri (dengan `SITE_URL` di `localhost`), atau
  pakai HTTPS.

## Di belakang reverse proxy

Untuk menjangkau Watchbell lewat HTTPS (misalnya dari luar rumah), jalankan reverse proxy seperti Caddy atau nginx di
mesin yang sama, tetap pakai `HOST=127.0.0.1`, lalu set:

```bash
SITE_URL=https://watchbell.your-domain.example
WATCHBELL_TRUSTED_PROXY_HOPS=1
```

`WATCHBELL_TRUSTED_PROXY_HOPS` adalah jumlah proxy di depan Watchbell yang menambahkan alamat client ke
`X-Forwarded-For`. Kalau di-set, rate limit sign-in dan setup berlaku per alamat client; kalau tidak, alamat apa pun
yang dikirim client diabaikan dan hanya batas keseluruhan yang berlaku. Jangan set ini tanpa proxy: client bisa
memalsukan alamatnya. Dengan `SITE_URL` `https://`, cookie session ditandai Secure.

Kalau Anda memakai reverse proxy, set pengaturan ini. Password yang salah membuat percobaan berikutnya menunggu makin
lama (setelah 5 kali gagal, setiap percobaan baru menunggu dua kali lebih lama dari sebelumnya: 30 detik, 1 menit,
2 menit, sampai satu jam), dihitung per email dari satu alamat dan per alamat. Dengan pengaturan ini, kegagalan dari
alamat orang lain tidak akan pernah mengunci Anda, dan satu akun tetap hanya mendapat 50 kegagalan gratis per hari dari
semua alamat sebelum waktu tunggu berlaku untuk alamat yang tidak sign-in ke akun itu dalam 90 hari terakhir (memakai
session yang sudah sign-in dari sebuah alamat juga dihitung, jadi alamat yang terus Anda pakai tetap dikenal). Tanpa pengaturan ini Watchbell tidak bisa membedakan alamat, jadi
hitungannya hanya per email, dan siapa pun yang tahu email Anda bisa memperlambat sign-in Anda sendiri. Kode
authenticator yang salah diperlakukan sama. Sepuluh password salah atau sepuluh kode salah untuk satu akun dalam sehari
mengirim pemberitahuan ke Telegram (paling banyak sekali per jam). `/api/ping` dan halaman sign-in juga punya batas kecil
per alamat yang disimpan di memori, yang memakai pengaturan yang sama.

Membuka Watchbell ke internet adalah keputusan dan tanggung jawab Anda; selalu update, pakai password yang kuat, dan
pakai authenticator.

## Memakai Postgres sendiri

Database PGlite lokal adalah setup yang sudah diuji dan didukung, dan sudah cukup untuk satu orang atau tim kecil.
`DATABASE_URL` bisa diarahkan ke server Postgres (`postgres://user:password@host:5432/dbname`), tetapi di versi ini hal
itu hanya untuk pengguna tingkat lanjut:

- Watchbell tidak membuat tabelnya sendiri di sana. PGlite mendapat tabelnya secara otomatis saat start; database
  eksternal butuh migrasi di `app/drizzle-selfhost` yang Anda terapkan sendiri lebih dulu.
- Koneksinya selalu memakai SSL, jadi server harus menerima koneksi SSL.
- Database Supabase hosted ditolak di mode self-host, begitu juga alamat apa pun yang tidak bisa diperiksa Watchbell,
  kecuali Anda juga men-set `WATCHBELL_ALLOW_REMOTE_DB=1`.
- Lakukan URL-encode pada karakter khusus di password (`# @ [ ] / ? :`).
