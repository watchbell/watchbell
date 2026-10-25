# Backup

English: [../backups.md](../backups.md)

Ada dua hal berbeda yang perlu dijaga:

1. **Watchbell itu sendiri**: folder `app/data` (database-nya) dan `app/.env` (pengaturan dan encryption key-nya),
   atau `~/.watchbell/data` dan `~/.watchbell/.env` kalau Anda memakai paket npm. Inilah yang Anda restore setelah disk
   rusak atau saat Anda pindah ke mesin lain.
2. **Ringkasan bulanan di Google Drive** (opsional): catatan yang mudah dibaca untuk setiap bulan (uptime, insiden,
   database, domain), disimpan di luar mesin Anda. Ini adalah laporan, bukan salinan database.

- [Mem-backup Watchbell itu sendiri](#mem-backup-watchbell-itu-sendiri)
- [Restore atau pindah ke mesin lain](#restore-atau-pindah-ke-mesin-lain)
- [Ringkasan bulanan di Google Drive](#ringkasan-bulanan-di-google-drive)
- [Membuat Google OAuth client sendiri](#membuat-google-oauth-client-sendiri)

## Mem-backup Watchbell itu sendiri

Hentikan Watchbell dulu: menyalin folder database saat database itu masih terbuka bisa menghasilkan salinan yang rusak.
Jalankan perintah berikut dari folder Watchbell.

**Linux:**

```bash
systemctl --user stop watchbell
tar czf ~/watchbell-backup-$(date +%F).tar.gz -C app data .env
systemctl --user start watchbell
```

**Windows (PowerShell):**

```powershell
cd app; npm run stop:selfhost; cd ..
Compress-Archive -Path app\data, app\.env -DestinationPath "$HOME\watchbell-backup-$(Get-Date -Format yyyy-MM-dd).zip"
Start-ScheduledTask Watchbell
```

Kalau Anda menjalankan Watchbell secara manual, hentikan dengan Ctrl+C (atau `npm run stop:selfhost` di `app/`), lalu
jalankan lagi dengan `npm run start:selfhost`. Pakai `Stop-ScheduledTask Watchbell` hanya kalau
`npm run stop:selfhost` kehabisan waktu di Windows.

Simpan backup-nya di tempat selain disk yang sama. Backup ini berisi `app/.env`, jadi berisi juga encryption key Anda:
simpan seperti Anda menyimpan password.

### Kenapa app/.env penting

`OPS_ENCRYPTION_KEY` di `app/.env` mengenkripsi setiap token provider, koneksi Google Drive, webhook Discord, dan
setiap secret authenticator di database. Salinan `app/data` tanpa key yang cocok tetap bisa dibuka, tetapi:

- setiap connection menampilkan "Can't read the stored credential" sampai Anda mengganti token-nya;
- Google Drive harus dihubungkan ulang;
- kode authenticator berhenti bekerja, jadi setiap owner dan operator perlu `npm run reset-login -- <email>` (lihat
  [Pertama kali dijalankan](first-run.md#tidak-bisa-masuk)).

Password sendiri disimpan sebagai hash satu arah dan tetap bisa dipakai.

### Dengan paket npm

Dengan `npm install -g watchbell`, database dan pengaturan ada di `~/.watchbell/` (`%USERPROFILE%\.watchbell\` di
Windows, atau folder yang ditunjuk `WATCHBELL_HOME`): `data/` dan `.env`. Aturannya sama: hentikan Watchbell, salin
keduanya, lalu jalankan lagi.

**Linux dan macOS:**

```bash
watchbell stop
tar czf ~/watchbell-backup-$(date +%F).tar.gz -C ~/.watchbell data .env
watchbell
```

**Windows (PowerShell):**

```powershell
watchbell stop
Compress-Archive -Path "$HOME\.watchbell\data", "$HOME\.watchbell\.env" -DestinationPath "$HOME\watchbell-backup-$(Get-Date -Format yyyy-MM-dd).zip"
watchbell
```

Kalau Anda memasangnya dengan `watchbell service install`, pakai perintah yang ditampilkan saat itu: di Linux
`systemctl --user stop watchbell` dan `systemctl --user start watchbell`; di Windows dan macOS `watchbell stop`, lalu
log out dan log in lagi (atau jalankan `watchbell`) untuk menyalakannya. `watchbell status` menunjukkan apakah Watchbell
masih berjalan dan folder mana yang dipakainya.

## Restore atau pindah ke mesin lain

1. Pasang Watchbell di mesin baru seperti dijelaskan di [Instalasi](install.md), tetapi sebelum menjalankan installer,
   taruh `.env` yang Anda simpan di `app/.env` dan folder `data` yang Anda simpan di `app/data`:

   ```bash
   tar xzf ~/watchbell-backup-2026-10-01.tar.gz -C app
   bash install.sh
   ```

   ```powershell
   Expand-Archive watchbell-backup-2026-10-01.zip -DestinationPath app
   .\install.bat
   ```

   Installer mempertahankan setiap nilai yang sudah ada di `app/.env` dan hanya menambahkan key yang belum ada.
2. Kalau alamatnya berubah (port lain, atau akses LAN), perbarui `SITE_URL` di `app/.env`, serta redirect URI di
   Google OAuth client Anda kalau Anda memakainya.
3. Jalankan Watchbell lalu sign in dengan akun Anda yang biasa.

Dengan paket npm: pasang paketnya (`npm install -g watchbell`), ekstrak backup ke `~/.watchbell/` sebelum start pertama
(`tar xzf ~/watchbell-backup-2026-10-01.tar.gz -C ~/.watchbell`, atau `Expand-Archive` ke `$HOME\.watchbell` di
Windows), lalu jalankan `watchbell`. Start pertama mempertahankan setiap nilai yang sudah ada di `.env` dan hanya
menambahkan key yang belum ada.

Untuk restore di mesin yang sama: hentikan Watchbell, pindahkan `app/data` yang sekarang ke tempat lain, ekstrak backup
ke `app`, lalu jalankan Watchbell lagi. Restore dengan versi Watchbell yang sama dengan yang membuat backup, atau yang
lebih baru: perubahan database untuk versi yang lebih baru diterapkan otomatis saat versi itu dijalankan, tetapi tidak
ada yang membatalkannya untuk versi yang lebih lama.

## Ringkasan bulanan di Google Drive

**Backups** (khusus owner) menyimpan ringkasan setiap bulan ke Google Drive Anda, di folder bernama **Watchbell
backups**:

| File | Isinya |
|---|---|
| Summary sheet (Google Sheets) | Tab: Overview (uptime, insiden, dan deployment bulan itu), Applications (uptime %, response p95, jumlah 5xx, deploy per aplikasi), Incidents (setiap alert dengan waktu mulai, selesai, dan durasinya), Databases (perubahan status, ukuran, CU-hour, read Firestore), Domains (tanggal kedaluwarsa sertifikat dan registrar di akhir bulan) |
| Data mentah `.csv.gz` | Rollup per jam dan event bulan itu |

- Berjalan sendiri setiap tanggal 1 bersama job harian (sekitar pukul 03:00 di zona waktu Anda) dan mencakup bulan
  sebelumnya. Run yang gagal dicoba lagi oleh run harian berikutnya. **Back up now** menulis bulan berjalan sampai saat
  ini.
- Backup yang lebih tua dari 3 bulan dipindahkan ke trash Drive, dan Drive menghapusnya permanen 30 hari kemudian.
- Database ditampilkan dengan alias-nya (db-a, db-b) dan email disembunyikan, sama seperti di bagian lain console.
- Watchbell hanya meminta izin `drive.file` ke Google: ia hanya bisa melihat dan mengubah file yang dibuatnya sendiri,
  tidak pernah isi Drive Anda yang lain. Anda bisa mencabut aksesnya kapan saja di pengaturan Google Account Anda.

Ringkasan ini untuk dibaca dan menyimpan riwayat. Watchbell tidak bisa mengimpornya kembali; untuk me-restore
Watchbell, pakai backup `app/data` dan `app/.env` di atas.

## Membuat Google OAuth client sendiri

Watchbell terhubung ke Drive dengan OAuth client yang Anda buat di Google Cloud project milik Anda sendiri. Gratis.

1. Buka https://console.cloud.google.com lalu buat project (atau pilih yang sudah ada).
2. **APIs & Services › Library**: aktifkan **Google Drive API**.
3. **Google Auth Platform** (di beberapa akun disebut **OAuth consent screen**): siapkan dengan user type
   **External**, nama aplikasi seperti "Watchbell", dan email Anda. Tambahkan scope `.../auth/drive.file`.
4. Set publishing status ke **In production**. Dengan status "Testing", Google memutus koneksi setelah 7 hari dan Anda
   harus menghubungkan ulang setiap minggu. `drive.file` adalah scope yang tidak sensitif, jadi publikasi tidak perlu
   direview oleh Google.
5. **Credentials › Create credentials › OAuth client ID**, tipe **Web application**. Di bawah **Authorized redirect
   URIs**, tambahkan:

   ```text
   http://localhost:3100/auth/google/callback
   ```

   Pakai `SITE_URL` Anda sendiri dengan `/auth/google/callback` di belakangnya kalau berbeda. Google hanya menerima
   `http://` biasa untuk `localhost`; untuk alamat lain, `SITE_URL` harus `https://`. Kalau Anda juga ingin membuat
   project Firebase dari Watchbell, tambahkan juga `<SITE_URL>/auth/google/create/callback` (lihat
   [Provider](providers.md#firebase)).
6. Salin client ID dan secret ke `app/.env` lalu restart Watchbell:

   ```bash
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

7. Di Watchbell: **Backups › Connect Google Drive**, setujui satu izin itu, dan selesai.

Kalau Google menjawab `redirect_uri_mismatch`, redirect URI di langkah 5 tidak persis sama dengan `SITE_URL` ditambah
`/auth/google/callback` (periksa port dan `http`/`https`-nya).
