# Troubleshooting

English: [../troubleshooting.md](../troubleshooting.md)

Mulailah dari log server; sebagian besar masalah menampilkan baris yang jelas di sana.

| Cara Watchbell berjalan | Lokasi log-nya |
|---|---|
| Service Linux | `journalctl --user -u watchbell -f` |
| Scheduled Task Windows | `app\data\watchbell.log` |
| Dijalankan manual | Terminal tempat Anda menjalankan `npm run start:selfhost` |
| Paket npm, `watchbell` di terminal | `~/.watchbell/logs/watchbell.log` (**Show live log** di menu awal mengikutinya); `watchbell start --verbose` menampilkannya di terminal |

- [Instalasi](#instalasi)
  - [Port sudah dipakai](#port-sudah-dipakai)
  - [Versi Node salah](#versi-node-salah)
  - [Build kehabisan memori](#build-kehabisan-memori)
  - [npm ci gagal](#npm-ci-gagal)
  - [Windows: running scripts is disabled](#windows-running-scripts-is-disabled)
  - [Upgrade menolak melakukan pull](#upgrade-menolak-melakukan-pull)
- [Menjalankan](#menjalankan)
  - [Another Watchbell is already using](#another-watchbell-is-already-using)
  - [Missing or invalid environment variables](#missing-or-invalid-environment-variables)
  - [Menolak start dengan DATABASE_URL remote](#menolak-start-dengan-database_url-remote)
  - [Migrasi database tidak ditemukan](#migrasi-database-tidak-ditemukan)
  - [Halaman tidak terbuka](#halaman-tidak-terbuka)
  - [Service berhenti bekerja setelah update Node](#service-berhenti-bekerja-setelah-update-node)
- [Sign in](#sign-in)
  - [Kode setup hilang](#kode-setup-hilang)
  - [Tidak bisa masuk](#tidak-bisa-masuk)
- [Provider](#provider)
  - [Token kekurangan izin](#token-kekurangan-izin)
  - [Can't read the stored credential](#cant-read-the-stored-credential)
  - [Google menjawab redirect_uri_mismatch](#google-menjawab-redirect_uri_mismatch)
- [Notifikasi](#notifikasi)
  - [Tidak ada notifikasi yang masuk](#tidak-ada-notifikasi-yang-masuk)
  - [Tombol Telegram di laptop](#tombol-telegram-di-laptop)
- [Alert setelah laptop sleep](#alert-setelah-laptop-sleep)

## Instalasi

### Port sudah dipakai

Installer menyatakan port-nya (3100 secara default) sudah terpakai, atau server berhenti dengan `EADDRINUSE`.

- Mungkin Watchbell sudah berjalan: `systemctl --user status watchbell`, atau cari `node` di Task Manager.
- Cari program yang memakai port itu:

  ```bash
  ss -ltnp | grep 3100                       # Linux
  lsof -iTCP:3100 -sTCP:LISTEN               # macOS
  ```

  ```powershell
  Get-NetTCPConnection -LocalPort 3100 | Select-Object OwningProcess
  Get-Process -Id <OwningProcess>
  ```

- Atau pakai port lain: `bash install.sh --port 3200` (`install.bat --port 3200`) untuk instalasi baru, atau ubah
  `PORT` dan `SITE_URL` di `app/.env` pada instalasi yang sudah ada (lihat
  [Mengganti port](configuration.md#mengganti-port)).

### Versi Node salah

Watchbell butuh tepat Node 24 (24.x apa pun). Periksa dengan `node --version`.

- **Linux dan macOS dengan nvm:** `nvm install 24`, lalu `nvm use 24` (atau `nvm alias default 24` agar tetap
  dipakai).
- **Windows:** unduh Windows Installer (.msi) untuk Node 24 dari https://nodejs.org/dist/latest-v24.x/ (juga ada di
  bawah v24 di https://nodejs.org/en/about/previous-releases) lalu jalankan; seperti installer Windows biasa, ia
  meminta persetujuan administrator. Kalau ada Node yang lebih lama atau lebih baru yang terpasang, hapus dulu di
  Settings › Apps › Installed apps. Lalu buka terminal **baru**, supaya Node yang baru ada di `PATH`, pastikan
  `node -v` menampilkan v24, dan jalankan `install.bat` lagi. (Paket Node.js LTS dari winget dipasang untuk seluruh
  mesin, juga butuh persetujuan administrator, dan bisa memilih versi mayor yang lebih baru dari 24, jadi .msi di atas
  adalah jalan yang lebih sederhana.)
- Kalau `node --version` masih menampilkan versi lama, ada Node lain yang lebih dulu ada di `PATH` Anda
  (`which -a node` di Linux dan macOS, `where.exe node` di Windows).

Di Linux, installer bertanya dulu sebelum memasang Node 24 dengan nvm; kalau Anda menjawab tidak, installer menampilkan
langkah-langkah ini lalu berhenti tanpa menulis apa pun. Di Windows, installer selalu menampilkan link unduhan Node 24
lalu berhenti tanpa menulis apa pun.

### Build kehabisan memori

`npm run build` berhenti dengan `JavaScript heap out of memory` atau dimatikan. Build butuh sekitar 2 GB memori kosong.
Tutup program lain lalu jalankan installer lagi. Di server Linux kecil, tambahkan swap file. Untuk memberi Node lebih
banyak memori: `NODE_OPTIONS=--max-old-space-size=3072 bash install.sh`.

### npm ci gagal

- Periksa koneksi internet dan pengaturan proxy Anda (`npm config get proxy`).
- `npm ci` butuh `app/package-lock.json` dari rilis; jangan dihapus.
- Hapus `app/node_modules` lalu jalankan installer lagi.
- Di Windows, path yang lebih panjang dari 260 karakter bisa merusak instalasi: pindahkan folder Watchbell lebih dekat
  ke root drive (misalnya `D:\watchbell`).

### Windows: running scripts is disabled

PowerShell menolak `install.ps1` dengan pesan "running scripts is disabled on this system". Pakai `install.bat`, yang
mengizinkan script hanya untuk satu proses PowerShell itu, atau jalankan:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Watchbell tidak pernah mengubah execution policy sistem Anda.

### Upgrade menolak melakukan pull

`--upgrade` hanya menjalankan `git pull --ff-only` di git checkout yang file-file ter-track-nya tidak punya perubahan
lokal (file baru seperti `app/.env` dan `app/data` tidak dihitung). Jalankan `git status` untuk melihat apa yang
berubah. Sisihkan perubahan Anda dengan `git stash` (atau commit di sebuah branch), lalu jalankan upgrade lagi.
`app/.env` dan `app/data` Anda tidak pernah disentuh oleh upgrade. Kalau Anda memasang dari arsip rilis, lihat
[Upgrade](install.md#upgrade).

## Menjalankan

### Another Watchbell is already using

Server atau `reset-login` berhenti dengan pesan "Another Watchbell is already using …/data/pg. Stop it first."

Hanya satu proses yang boleh membuka folder database dalam satu waktu. Biasanya Watchbell memang sudah berjalan,
misalnya sebagai service atau Scheduled Task sementara Anda juga menjalankannya secara manual. Hentikan salah satunya:

- `systemctl --user stop watchbell` (service Linux)
- `npm run stop:selfhost` di folder `app` (task Windows, atau cara jalan apa pun); `Stop-ScheduledTask Watchbell` hanya
  kalau perintah itu kehabisan waktu, karena bisa memotong proses penutupan database
- `watchbell stop` (paket npm)
- Ctrl+C di terminal yang menjalankannya

Lock-nya adalah file `app/data/pg/.watchpost.lock` (`~/.watchbell/data/pg/.watchpost.lock` untuk paket npm), yang
berisi process id. Lock yang tertinggal dari proses yang sudah tidak ada dihapus otomatis, begitu juga lock yang
process id-nya sekarang dimiliki program lain (setelah crash atau listrik padam, id itu sering dipakai ulang):
`watchbell` dan `npm run start:selfhost` menghapusnya sebelum server mulai. Kalau id itu sekarang dimiliki program
Node.js lain, Watchbell tidak bisa membedakannya dari dirinya sendiri: `watchbell` lalu menyatakan bahwa tidak ada yang
menjawab dan menyebut nama file-nya. Hapus file itu secara manual hanya kalau Anda yakin tidak ada Watchbell yang
sedang berjalan.

### Missing or invalid environment variables

`Missing or invalid environment variables: OPS_ENCRYPTION_KEY` (atau key lain) berarti `app/.env` tidak punya key itu
atau nilainya berbentuk salah (`OPS_ENCRYPTION_KEY` harus ter-decode menjadi tepat 32 byte). Jalankan installer lagi:
installer menambahkan key yang belum ada dan membiarkan key yang sudah ada. Kalau key-nya ada tetapi salah, kembalikan
dari backup `app/.env` Anda; key yang baru dibuat membuat token yang tersimpan tidak bisa dibaca (lihat
[Backup](backups.md#kenapa-appenv-penting)).

"The scheduler settings are missing" (atau "Missing or invalid scheduler settings") berarti `COLLECTOR_SECRET` atau
`CRON_SECRET` tidak ada atau terlalu pendek. Installer juga menambahkan keduanya.

### Menolak start dengan DATABASE_URL remote

"Refusing to start: WATCHBELL_MODE=selfhost with a remote or unrecognised DATABASE_URL" berarti `DATABASE_URL` adalah
database Supabase hosted, URL dengan beberapa host, atau URL yang tidak bisa di-parse Watchbell. Mode self-host
menolaknya kecuali Anda juga men-set `WATCHBELL_ALLOW_REMOTE_DB=1`. Untuk database lokal, set
`DATABASE_URL=pglite:` di `app/.env`; `postgres://user:password@localhost/dbname` biasa diterima apa adanya. Lihat
[Memakai Postgres sendiri](configuration.md#memakai-postgres-sendiri) kalau Anda memang bermaksud memakai database
remote.

### Migrasi database tidak ditemukan

"Watchbell can't find its database migrations in …" berarti server dijalankan dari folder lain. Jalankan dari `app/`
(`cd app && npm run start:selfhost`), atau set `WATCHBELL_MIGRATIONS_DIR`.

### Halaman tidak terbuka

- Apakah Watchbell berjalan? Periksa log-nya.
- Pakai alamat yang benar: `http://localhost:3100` (atau port Anda), bukan `https://`.
- Dari perangkat lain hanya bisa dengan [akses LAN](configuration.md#akses-lan).
- `PORT` atau `HOST` yang di-set di shell menang atas `app/.env` (lihat
  [Menjalankan dan menghentikan](install.md#menjalankan-dan-menghentikan)). Paket npm mengabaikannya: ia membaca
  `~/.watchbell/.env`, dan hanya `WATCHBELL_HOST` atau `WATCHBELL_PORT` yang bisa menimpanya.

### Service berhenti bekerja setelah update Node

Di Linux, systemd service menjalankan program Node persis yang dipakai saat service dibuat (dengan nvm, sebuah path di
dalam `~/.nvm/versions`). Setelah `nvm install` untuk 24.x yang lebih baru, atau setelah versi lama dihapus, service
bisa gagal start (`journalctl --user -u watchbell` menampilkan path yang hilang). Jalankan lagi `bash install.sh`:
installer menulis ulang service untuk Node yang sekarang dan mem-build ulang aplikasi. `app/.env` dan `app/data` Anda
dipertahankan. Dengan paket npm, jalankan lagi `watchbell service install` setelah mengganti Node (nvm, fnm, volta):
service menjalankan Node yang dipakai saat service dibuat.

## Sign in

### Kode setup hilang

Baca lagi dari `app/data/setup-code`, atau dari log. Kalau sudah kedaluwarsa (setelah 24 jam) atau Anda tidak bisa
menemukannya, restart Watchbell: setiap start tanpa owner menampilkan dan menyimpan kode baru. Begitu owner sudah ada,
tidak ada lagi kode setup; lihat [Pertama kali dijalankan](first-run.md).

### Tidak bisa masuk

Lupa password, atau kehilangan authenticator? Di mesin tempat Watchbell berjalan:

```bash
# stop Watchbell first, then in the app folder:
npm run reset-login -- you@example.com
```

Kalau memakai paket npm, jalankan `watchbell stop`, lalu `watchbell reset-login you@example.com`.
Perintah ini menampilkan password sementara (berlaku 7 hari), menghapus authenticator, dan mengakhiri session akun
itu. Jalankan Watchbell, sign in dengan password sementara, pilih password baru, lalu pasang authenticator lagi. Kalau
muncul "Watchbell is running on …", hentikan Watchbell dulu. Kalau muncul "No Watchbell database in …", jalankan di
folder `app` (atau set `WATCHBELL_DATA_DIR`). Detailnya di
[Pertama kali dijalankan](first-run.md#tidak-bisa-masuk).

## Provider

### Token kekurangan izin

Provider menjawab bahwa token tidak bisa melakukan sesuatu, misalnya:

- "missing database_write" saat menyiapkan role SQL Supabase secara otomatis;
- "This Supabase token can't create projects" (`organization_projects_create`);
- "This Cloudflare token can't add DNS records" (DNS Edit).

Membaca tetap bisa; hanya aksi itu yang butuh izin lebih. Buat token baru dengan izin tambahan yang tercantum di
[Menghubungkan provider](providers.md), lalu pakai **Replace credential** di Connections. Atau kerjakan satu langkah
itu secara manual di provider (untuk role SQL, dialog-nya menampilkan SQL yang bisa Anda jalankan sendiri).

### Can't read the stored credential

"Can't read the stored credential. The encryption key changed." berarti `OPS_ENCRYPTION_KEY` di `app/.env` bukan key
yang dipakai saat token disimpan. Kembalikan key aslinya dari backup Anda, atau pakai Replace credential di setiap
connection.

### Google menjawab redirect_uri_mismatch

Authorized redirect URI di Google OAuth client Anda harus persis `SITE_URL` + `/auth/google/callback`, misalnya
`http://localhost:3100/auth/google/callback`. Periksa port dan `http` versus `https`. Google hanya mengizinkan `http`
biasa untuk `localhost`. Lihat [Backup](backups.md#membuat-google-oauth-client-sendiri).

## Notifikasi

### Tidak ada notifikasi yang masuk

Di **Alerts › Notifications**:

- Channel menampilkan catatan seperti "TELEGRAM_BOT_TOKEN isn't set": tambahkan key itu ke `app/.env` lalu restart.
- Channel dalam keadaan **Off**: nyalakan.
- "The last send failed: …" menampilkan alasan dari provider (bot token yang dicabut, webhook Discord yang dihapus,
  domain Resend yang belum diverifikasi).
- Tekan **Send test**.

Periksa juga [aturan senyap](notifications.md#aturan-senyap): selama collector basi, selama maintenance window, untuk
alert yang di-silence, atau untuk aplikasi di belakang database yang di-pause, memang sengaja tidak ada yang dikirim.

### Tombol Telegram di laptop

Approve dan Reject di pesan Telegram tidak berfungsi, atau responsnya terlambat:

- **Watchbell tidak berjalan.** Laptop tidak punya alamat publik, jadi Watchbell mengambil sendiri tekanan tombol dari
  Telegram selama ia berjalan. Tekanan yang dilakukan saat Watchbell berhenti atau sleep diproses saat ia kembali
  (Telegram menyimpannya sampai 24 jam).
- **Tombol approval mati.** Alerts › Notifications › Telegram › Approval buttons › Turn on.
- **Akun Telegram Anda belum ditautkan.** Hanya akun yang sudah ditautkan yang bisa memakai tombol: tekan Show link code
  lalu kirim `/link <code>` di chat yang terhubung.
- **Log menyatakan "Telegram has a webhook set".** Ada pihak lain yang menerima update bot ini: webhook yang dipasang
  instalasi lain, atau program lain yang membaca bot yang sama. Pakai bot terpisah untuk Watchbell ini, atau matikan
  lalu nyalakan lagi tombol approval di sini (itu menghapus webhook-nya, yang akan merusak instalasi lain itu).
- **Aksi berisiko** butuh tekanan kedua pada "Sure? Approve" dalam 2 menit.

Anda selalu bisa menyetujui di halaman Auto-actions sebagai gantinya.

## Alert setelah laptop sleep

Selama mesin sleep atau Watchbell berhenti, tidak ada yang dicek. Setelah bangun, alert **CollectorStale** bisa firing
sebentar lalu resolved setelah beberapa run berikutnya berhasil; alert lain dibungkam selama alert itu firing. Job
harian yang terlewat dijalankan sekali saat bangun. Untuk pemantauan yang tidak pernah tidur, jalankan Watchbell di
mesin yang selalu menyala.
