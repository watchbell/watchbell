# Instalasi

English: [../install.md](../install.md)

Watchbell berjalan di satu mesin: laptop Anda, PC desktop yang selalu menyala, atau server kecil. Datanya disimpan di
folder database lokal (PGlite, yaitu Postgres yang dikompilasi ke WebAssembly), ia menjalankan scheduler-nya sendiri,
dan tidak butuh akun cloud apa pun untuk mulai.

- [Yang Anda butuhkan](#yang-anda-butuhkan)
- [Mengambil kode](#mengambil-kode)
- [Instalasi cepat dengan npm](#instalasi-cepat-dengan-npm)
- [Linux](#linux)
- [Windows](#windows)
- [macOS dan instalasi manual](#macos-dan-instalasi-manual)
- [Opsi installer](#opsi-installer)
- [Lokasi file dan folder](#lokasi-file-dan-folder)
- [Menjalankan dan menghentikan](#menjalankan-dan-menghentikan)
- [Upgrade](#upgrade)
- [Uninstall](#uninstall)

## Yang Anda butuhkan

- **Node.js 24** (rilis 24.x mana pun) beserta npm. Versi mayor lain ditolak. Di Linux, installer menawarkan untuk
  memasang Node 24 untuk Anda; di Windows Anda memasangnya sendiri dari nodejs.org terlebih dahulu (lihat
  [Windows](#windows)).
- Sekitar **2 GB ruang disk kosong** untuk dependency dan build, ditambah ruang untuk data Anda.
- **RAM 2 GB** atau lebih disarankan. Build adalah langkah paling berat; console yang sudah berjalan butuh jauh lebih
  sedikit.
- **git**, kalau Anda ingin `--upgrade` mengambil versi baru untuk Anda.
- Linux: installer diuji di Ubuntu 22.04 dan 24.04. Distribusi lain yang punya bash dan systemd seharusnya juga bisa.
- Windows: Windows 10 atau 11 dengan Windows PowerShell 5.1 (sudah bawaan).

Installer Watchbell tidak pernah memakai `sudo` atau hak administrator, tidak pernah memasang paket sistem tanpa
bertanya, dan tidak pernah membuka port firewall. (Memasang Node itu sendiri di Windows memakai installer Windows
biasa, yang meminta persetujuan administrator; lihat di bawah.)

## Mengambil kode

Clone repository-nya (disarankan, supaya upgrade cukup satu perintah), atau unduh arsip rilis dari halaman GitHub
releases proyek ini lalu ekstrak.

Ekstrak atau clone ke **folder baru yang kosong** (misalnya `~/watchbell` di Linux dan macOS, atau `C:\watchbell` di
Windows), jangan ke folder yang sudah berisi file lain: file yang tercampur dari proyek lain atau salinan lama akan
merusak instalasi.

```bash
git clone https://github.com/watchbell/watchbell.git watchbell
cd watchbell
```

Semua langkah di bawah dijalankan dari folder ini, yaitu folder yang berisi `install.sh`, `install.bat`, dan folder
`app/`.

## Instalasi cepat dengan npm

Paket npm adalah Watchbell yang sudah di-build: tanpa clone, tanpa build, dan tidak ada yang dijalankan saat paket
dipasang. Paket ini butuh Node 24 seperti installer, dan bisa dipakai di Linux, Windows, dan macOS.

```bash
npm install -g watchbell
watchbell
```

Saat pertama kali dijalankan, ia membuat `~/.watchbell/` (di Windows `%USERPROFILE%\.watchbell\`) berisi `.env`
(pengaturan Anda, dengan secret baru, hanya bisa dibaca oleh user Anda) dan `data/` (database), menampilkan kode setup
sekali pakai, lalu membuka http://localhost:3100/setup. Set `WATCHBELL_HOME` untuk memakai folder lain.
`watchbell --help` menampilkan semua perintah: `stop`, `status`, `update`, `service install|uninstall` (berjalan
otomatis saat login lewat systemd user service, Scheduled Task, atau launchd agent di macOS; tanpa hak admin),
`reset-login <email>`. Setelah Anda mengganti Node.js (nvm, fnm, volta, Homebrew), jalankan lagi
`watchbell service install`; `watchbell status` memberi peringatan kalau Node.js yang dipakai service sudah tidak ada.

Alamatnya diambil dari `~/.watchbell/.env` (`HOST`, `PORT`, `SITE_URL`). `HOST` atau `PORT` yang di-export oleh shell
Anda diabaikan, jadi shell yang men-set variabel itu untuk program lain tidak bisa memindahkan Watchbell ke jaringan
Anda atau ke port lain; set `WATCHBELL_HOST` atau `WATCHBELL_PORT` untuk sengaja menimpa isi file, atau `--host` dan
`--port` untuk satu kali jalan (lihat [Membukanya dari komputer lain](#membukanya-dari-komputer-lain)).

Update dengan `watchbell update`. Perintah ini menjalankan `npm install -g watchbell@latest` dengan npm yang ada di
samping Node.js Anda; service yang Anda pasang dengan `watchbell service install` dihentikan dulu lalu dijalankan
lagi sesudahnya, sedangkan Watchbell yang Anda jalankan di terminal harus dihentikan dulu (`watchbell stop`). Kalau
folder global npm dimiliki root (Node.js dari paket distribusi Anda), hentikan Watchbell lalu jalankan
`sudo npm install -g watchbell@latest`. `watchbell` dan `watchbell status` memberi tahu Anda kalau ada versi yang lebih
baru: keduanya bertanya ke registry.npmjs.org paling banyak sekali sehari (request biasa untuk nomor versi, tanpa
informasi apa pun tentang Anda); `WATCHBELL_NO_UPDATE_CHECK=1`, di `~/.watchbell/.env` atau di environment, mematikan
pengecekan ini.

Dari 1.0.x, update sekali secara manual, karena 1.0 belum punya `watchbell update`: `watchbell stop` (atau hentikan
service yang Anda pasang), lalu `npm install -g watchbell@latest`, lalu jalankan lagi. Mulai 1.1, `watchbell update`
yang mengerjakannya.

Saat pertama kali dijalankan, zona waktu komputer Anda ditulis ke `~/.watchbell/.env` yang baru sebagai
`WATCHBELL_TIMEZONE`. `.env` dari 1.0 tetap memakai Waktu Indonesia Barat (WIB) sampai Anda menambahkannya, misalnya
`WATCHBELL_TIMEZONE=Europe/Berlin`, lalu restart. Lihat [Zona waktu](configuration.md#zona-waktu).

Hapus dengan `watchbell service uninstall` (kalau Anda memasang service) dan `npm uninstall -g watchbell`; hapus
`~/.watchbell/` hanya kalau Anda tidak lagi membutuhkan datanya.

### Membukanya dari komputer lain

Watchbell hanya mendengarkan di mesin ini (`127.0.0.1`). Dari komputer lain, cara masuk yang paling aman adalah SSH
tunnel: tidak ada yang berubah di mesin Watchbell, dan koneksinya terenkripsi. Di komputer yang sedang Anda pakai,
jalankan

```bash
ssh -N -L 3100:127.0.0.1:3100 you@the-watchbell-machine
```

lalu buka http://localhost:3100 di sana. Tunnel aktif selama perintah itu berjalan.

Untuk membukanya ke jaringan Anda, beri alamat untuk satu kali jalan (`0.0.0.0` berarti semua jaringan di mesin ini):

```bash
watchbell --host 0.0.0.0 --port 3100
```

Ia menampilkan alamat yang bisa dipakai komputer lain, misalnya `http://192.168.1.20:3100`, beserta peringatan: siapa
pun yang bisa menjangkau alamat itu akan mendapat halaman sign-in, dan http biasa mengirim password yang bisa dibaca
di jaringan. Jadi selesaikan `/setup` (akun owner) sebelum Anda membagikan alamatnya, batasi ke jaringan yang Anda
percayai, dan jangan pernah membukanya ke internet tanpa HTTPS di depannya (lihat
[Di belakang reverse proxy](configuration.md#di-belakang-reverse-proxy)). Sign-in bisa dilakukan dari alamat mana pun
di antara itu. Link di alert dan pesan memakai `SITE_URL`, jadi set `SITE_URL=http://192.168.1.20:3100` (alamat Anda)
di `~/.watchbell/.env` kalau link itu juga harus bisa dibuka dari komputer lain. Agar alamatnya tetap, set `HOST`
(dan `PORT`) di file itu alih-alih memakai opsi; service membaca file tersebut.

Sisa panduan ini membahas installer, yang mem-build Watchbell dari repository ini.

## Linux

```bash
bash install.sh
```

Pakai `bash install.sh` seperti di atas: cara ini tetap jalan walaupun alat unduh atau ekstrak menghilangkan bit
executable file-nya. (`./install.sh` sama saja kalau bit itu ada.)

Installer menjalankan langkah-langkah berikut dan berhenti dengan pesan yang menyebut langkahnya kalau ada yang gagal:

1. **Memeriksa** sistem: OS, Node 24, npm, ruang disk kosong minimal 2 GB, dan RAM (hanya peringatan). Kalau Node 24
   belum ada atau versi mayor lain yang terpasang, installer bertanya dulu sebelum memasang Node 24 dengan
   [nvm](https://github.com/nvm-sh/nvm) (rilis nvm tertentu dari repository resminya) ke folder home Anda. Kalau Anda
   menjawab tidak, installer menampilkan cara memasangnya sendiri lalu berhenti tanpa menulis apa pun.
2. **Memeriksa port** (3100 kecuali Anda memberi `--port`). Kalau ada program lain yang sudah mendengarkan di sana,
   installer memberi tahu sebelum build dan menyarankan port lain.
3. **Menulis `app/.env`** kalau belum ada, dengan secret acak yang baru (lihat [Konfigurasi](configuration.md)). File
   itu hanya bisa dibaca oleh Anda (mode 600). Saat dijalankan ulang, installer hanya menambahkan key yang belum ada
   dan tidak pernah mengubah atau menampilkan nilai yang sudah ada, terutama `OPS_ENCRYPTION_KEY`.
4. Menjalankan `npm ci` dan `npm run build` di `app/`.
5. **Bertanya** apakah Watchbell perlu berjalan otomatis. Kalau Anda menjawab ya, installer membuat, mengaktifkan, dan
   menjalankan systemd **user** service, `~/.config/systemd/user/watchbell.service`, yang membaca `app/.env`. Kalau
   Anda menjawab tidak, installer menampilkan perintah untuk menjalankan Watchbell secara manual. Saat dijalankan
   ulang, service yang sedang berjalan dihentikan selama build ulang lalu dijalankan lagi.
6. Menampilkan alamat yang perlu dibuka: `http://localhost:3100/setup`.

Kalau installer memasang Node dengan nvm, buka terminal baru (atau jalankan `nvm use 24`) sebelum Anda memakai `npm`
sendiri.

Lalu lanjutkan ke [Pertama kali dijalankan](first-run.md).

### Tetap berjalan setelah Anda log out

Systemd user service berhenti saat Anda log out, kecuali lingering aktif untuk akun Anda. Installer menyarankan
perintahnya tetapi tidak pernah menjalankannya:

```bash
loginctl enable-linger "$USER"
```

## Windows

Klik dua kali `install.bat` di folder Watchbell, atau jalankan dari terminal agar Anda bisa memberi opsi:

```bat
install.bat --port 3200
```

`install.bat` menjalankan `install.ps1` dengan execution policy PowerShell dilonggarkan hanya untuk proses itu. Anda
juga bisa memanggil script-nya langsung dari PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Port 3200
```

Langkah-langkahnya sama dengan di Linux:

1. Memeriksa Windows, Node 24, npm, ruang disk kosong, dan RAM. Installer Windows tidak memasang Node untuk Anda.
   Kalau Node 24 belum ada, atau versi mayor lain yang terpasang, installer menampilkan tempat mengambil Node 24 lalu
   berhenti tanpa menulis apa pun:

   1. Unduh Windows Installer (.msi) untuk Node 24 dari https://nodejs.org/dist/latest-v24.x/ (atau pilih v24 di
      https://nodejs.org/en/about/previous-releases). Kalau ada versi Node lain yang terpasang, hapus dulu di
      Settings › Apps › Installed apps.
   2. Jalankan .msi dengan opsi default (npm sudah termasuk). Seperti installer Windows biasa, ia meminta persetujuan
      administrator.
   3. Buka terminal **baru** supaya `PATH` yang baru terbaca, pastikan `node -v` menampilkan v24, lalu jalankan
      `install.bat` lagi.
2. Memeriksa apakah port masih kosong.
3. Menulis `app\.env` kalau belum ada, atau hanya mengisi key yang belum ada atau masih kosong (nilai yang sudah ada
   dipertahankan), lalu membatasi file itu hanya untuk user Windows Anda (dengan `icacls`).
4. Menjalankan `npm ci` dan `npm run build`.
5. Bertanya apakah Watchbell perlu berjalan otomatis. Kalau Anda menjawab ya, installer mendaftarkan dan menjalankan
   Scheduled Task bernama **Watchbell** untuk user Anda. Task ini menjalankan Watchbell secara tersembunyi setiap kali
   Anda sign in, membaca `app\.env`, dan menambahkan output-nya ke `app\data\watchbell.log`. Windows bisa menjalankannya
   ulang kalau ia berhenti karena error; kalau tidak kembali jalan, jalankan lagi dengan
   `Start-ScheduledTask Watchbell` atau periksa `app\data\watchbell.log`. Saat installer dijalankan ulang, task yang
   sedang berjalan dihentikan selama build ulang lalu dijalankan lagi.
6. Menampilkan alamat yang perlu dibuka: `http://localhost:3100/setup`.

Kalau Anda menjalankan `install.bat` dengan klik dua kali, jendelanya tetap terbuka di akhir supaya Anda bisa membaca
alamatnya; tekan sembarang tombol untuk menutupnya.

Lalu lanjutkan ke [Pertama kali dijalankan](first-run.md).

## macOS dan instalasi manual

Belum ada installer untuk macOS. Langkah manual di bawah bisa dipakai di macOS, Linux, dan Windows (Git Bash).

1. Pasang Node 24, misalnya dengan [nvm](https://github.com/nvm-sh/nvm) (`nvm install 24`) atau dari
   [nodejs.org](https://nodejs.org). Periksa:

   ```bash
   node --version   # must print v24.something
   ```

2. Buat `app/.env` dengan secret baru:

   ```bash
   cd app
   cat > .env <<EOF
   WATCHBELL_MODE=selfhost
   DATABASE_URL=pglite:
   WATCHBELL_DATA_DIR=./data
   HOST=127.0.0.1
   PORT=3100
   SITE_URL=http://localhost:3100
   OPS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
   COLLECTOR_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
   CRON_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
   WATCHBELL_TIMEZONE=$(node -p "Intl.DateTimeFormat().resolvedOptions().timeZone")
   EOF
   chmod 600 .env
   ```

   Jalankan ini sekali saja. Membuat `OPS_ENCRYPTION_KEY` baru di kemudian hari membuat semua token yang tersimpan
   tidak bisa dibaca. `WATCHBELL_TIMEZONE` adalah zona waktu komputer Anda menurut penamaan Node.js; pastikan file itu
   berisi nama lengkap seperti `Europe/Berlin` (bukan `CET`), atau lihat [Zona waktu](configuration.md#zona-waktu).
   [`app/.env.example`](../../app/.env.example) berisi daftar pengaturan opsional.

3. Pasang dependency dan build:

   ```bash
   npm ci
   npm run build
   ```

4. Jalankan:

   ```bash
   npm run start:selfhost
   ```

   Biarkan terminalnya terbuka; Ctrl+C (atau `npm run stop:selfhost` di terminal lain) menghentikan Watchbell dengan
   rapi. Agar berjalan otomatis saat login, bungkus perintah itu dalam launchd agent (macOS) atau systemd user service
   (Linux) buatan Anda sendiri.

## Opsi installer

| Linux (`install.sh`) | Windows (`install.bat` atau `install.ps1`) | Fungsinya |
|---|---|---|
| `--yes` | `-Yes` | Menjawab ya untuk semua pertanyaan (memasang Node 24 dengan nvm di Linux, membuat auto-start). Untuk instalasi tanpa interaksi. |
| `--no-service` | `-NoService` | Melewati pertanyaan auto-start dan tidak membuat service maupun Scheduled Task. |
| `--port <n>` | `-Port <n>` | Memakai port `<n>` alih-alih 3100 (ditulis ke `PORT` dan `SITE_URL` di `app/.env` yang baru). |
| `--upgrade` | `-Upgrade` | Mengambil versi baru dulu (lihat [Upgrade](#upgrade)), lalu menjalankan langkah-langkah biasa. |
| `--help` | `-Help` | Menampilkan daftar opsi lalu keluar. |

`install.bat` juga menerima penulisan ala Linux (`install.bat --yes --no-service`). Opsi bisa digabung, misalnya:

```bash
bash install.sh --yes --no-service --port 3200
```

Exit code: `0` semuanya berhasil, `1` ada langkah yang gagal (pesannya menyebut langkah itu), `2` ada opsi yang salah.

`--port` hanya men-set port saat `app/.env` dibuat. Pada instalasi yang sudah ada, ubah `PORT` dan `SITE_URL` di
`app/.env` (lihat [Konfigurasi](configuration.md)).

## Lokasi file dan folder

| Path | Isinya |
|---|---|
| `app/.env` | Pengaturan dan secret Anda. Simpan salinannya di tempat aman; jangan pernah di-commit atau dibagikan. |
| `app/data/` | Semua yang disimpan Watchbell: database (`app/data/pg`), kode setup pertama kali, dan di Windows juga log-nya. |
| `app/data/setup-code` | Kode setup sekali pakai, sampai akun owner dibuat. |
| `app\data\watchbell.log` | Khusus Windows: output server saat berjalan sebagai Scheduled Task. Ukurannya terus bertambah; hapus saat Watchbell sedang berhenti kalau sudah terlalu besar. |
| `~/.config/systemd/user/watchbell.service` | Khusus Linux: service auto-start, kalau Anda memilihnya. |

Di Linux, output server masuk ke systemd journal: `journalctl --user -u watchbell -f`.

## Menjalankan dan menghentikan

**Linux, dengan service:**

```bash
systemctl --user status watchbell     # is it running?
systemctl --user restart watchbell    # after you edit app/.env
systemctl --user stop watchbell
systemctl --user start watchbell
journalctl --user -u watchbell -f     # follow the log
```

**Windows, dengan Scheduled Task** (di PowerShell, dari folder Watchbell):

```powershell
Start-ScheduledTask Watchbell
cd app; npm run stop:selfhost; cd ..        # clean stop
Get-Content app\data\watchbell.log -Tail 50 -Wait
```

`npm run stop:selfhost` meminta server yang sedang berjalan untuk berhenti dan menunggu sampai 30 detik agar server
menutup database-nya dengan rapi. Perintah ini keluar dengan 0 setelah Watchbell berhenti (atau kalau memang tidak
sedang berjalan). Kalau waktunya habis, `Stop-ScheduledTask Watchbell` menghentikan task secara paksa; pakai itu hanya
sebagai jalan terakhir, karena bisa memotong Watchbell yang sedang menutup database-nya.

**Manual, di OS apa pun:**

```bash
cd app
npm run start:selfhost
```

Hentikan dengan Ctrl+C, atau dengan `npm run stop:selfhost` dari terminal lain di `app/`, lalu tunggu sampai prosesnya
keluar: Watchbell menutup database-nya saat keluar, dan mematikannya di tengah proses itu bisa merusak folder data.
`npm run stop:selfhost` bekerja sama di setiap OS dan juga bisa menghentikan server milik service Linux, tetapi di sana
cara yang biasa adalah `systemctl --user stop watchbell`.

`npm run start:selfhost` membaca `app/.env`, termasuk `HOST` dan `PORT`. Pengaturan yang diberikan di shell menang atas
isi file, misalnya untuk memakai port lain untuk satu kali jalan:

```bash
PORT=3200 npm run start:selfhost             # Linux, macOS, Git Bash
```

```powershell
$env:PORT = "3200"; npm run start:selfhost   # Windows PowerShell
```

Satu folder data hanya bisa dipakai oleh satu Watchbell dalam satu waktu. Watchbell kedua akan berhenti dengan pesan
"Another Watchbell is already using …" (lihat
[Troubleshooting](troubleshooting.md#another-watchbell-is-already-using)).

## Upgrade

Berasal dari instalasi yang dibuat saat produk ini masih bernama Watchpost? Tidak ada yang rusak. `app/.env` Anda tetap
bekerja (nama lama `WATCHPOST_*` masih dibaca), dan `install.sh` / `install.bat` menawarkan untuk mengganti auto-start
lama (systemd service `watchpost.service`, atau Scheduled Task `Watchpost`) di folder ini dengan yang baru
(`watchbell.service`, atau task `Watchbell`). Uninstaller menghapus yang mana pun. Data Anda tidak disentuh.

Backup dulu: hentikan Watchbell lalu salin `app/data` dan `app/.env` ke tempat aman (lihat [Backup](backups.md)).

**Dengan git clone:**

```bash
bash install.sh --upgrade        # Linux
```

```bat
install.bat --upgrade
```

`--upgrade` menjalankan `git pull --ff-only`, tetapi hanya kalau folder itu adalah git checkout tanpa perubahan pada
file yang di-track (`app/.env` dan `app/data` Anda tidak dihitung). Kalau tidak, ia berhenti dan menjelaskan
alasannya. Setelah itu ia menjalankan langkah-langkah biasa: mempertahankan `app/.env` (hanya menambahkan key baru),
menjalankan `npm ci` dan `npm run build`. Service atau Scheduled Task yang sedang berjalan dihentikan selama build ulang
lalu dijalankan lagi di akhir. Kalau Anda menjalankan Watchbell secara manual, hentikan sebelum upgrade lalu jalankan
lagi sesudahnya. Perubahan database diterapkan otomatis saat versi baru dijalankan.

**Setelah Anda meng-upgrade Node itu sendiri** (misalnya 24.x yang lebih baru lewat nvm), jalankan lagi
`bash install.sh`. Service Linux menunjuk ke program Node persis yang dipakai saat service dibuat, dan menjalankan ulang
installer akan memperbaruinya sekaligus mem-build ulang aplikasi.

**Dengan arsip rilis:** hentikan Watchbell, ekstrak rilis baru ke folder baru, salin `app/.env` dan `app/data` dari
folder lama ke folder baru, lalu jalankan installer di sana. Kalau sebelumnya Anda memakai auto-start, jalankan dulu
uninstaller di folder lama, supaya service menunjuk ke folder baru.

## Uninstall

```bash
bash uninstall.sh                # Linux
```

```bat
uninstall.bat
```

Tambahkan `--yes` (`bash uninstall.sh --yes`, `uninstall.bat --yes`) untuk melewati konfirmasi.

Uninstaller meminta konfirmasi, lalu menghentikan Watchbell dan menghapus auto-start (systemd user service atau
Scheduled Task). Uninstaller tidak pernah menghapus data Anda: ia menampilkan lokasi `app/data` dan `app/.env`. Untuk
menghapus semuanya, hapus keduanya secara manual, lalu hapus folder Watchbell:

```bash
rm -rf app/data app/.env
```

```powershell
Remove-Item -Recurse -Force app\data, app\.env
```

Kalau Anda menyalakan lingering hanya untuk Watchbell, Anda bisa mematikannya lagi dengan
`loginctl disable-linger "$USER"`. Token yang Anda buat di provider (Vercel, Cloudflare, GitHub, dan lainnya) tetap
berlaku sampai Anda mencabutnya di sana.
