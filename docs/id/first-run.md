# Pertama kali dijalankan

English: [../first-run.md](../first-run.md)

Orang pertama yang menyelesaikan halaman setup menjadi **owner** Watchbell ini. Untuk memastikan orang itu adalah
Anda, halaman setup meminta kode sekali pakai yang hanya bisa dibaca oleh orang yang punya akses ke mesinnya.

## 1. Cari kode setup

Setiap kali Watchbell dijalankan dan belum punya owner, ia membuat kode baru lalu:

- menampilkannya di log server, sebagai baris seperti
  `Watchbell setup code: ABCDE-FGH23 (open http://localhost:3100/setup; valid 24 h)`;
- menyimpannya di `app/data/setup-code`.

Tempat membacanya:

| Cara Watchbell berjalan | Lokasi kodenya |
|---|---|
| Service Linux | `cat app/data/setup-code`, atau `journalctl --user -u watchbell` |
| Scheduled Task Windows | `Get-Content app\data\setup-code`, atau `app\data\watchbell.log` |
| Dijalankan manual | Terminal tempat Anda menjalankan `npm run start:selfhost` |
| Paket npm (`watchbell`) | Layar awal (`First run: setup code ...`), `~/.watchbell/data/setup-code`, atau `~/.watchbell/logs/watchbell.log` |

Kode berlaku selama 24 jam. Me-restart Watchbell menggantinya dengan kode baru (dan menghapus hitungan percobaan yang
gagal). Tanda hubung dan spasi tidak berpengaruh saat Anda mengetiknya, dan kode tidak pernah berisi 0, O, 1, I, atau
L.

## 2. Buat akun owner

Buka `http://localhost:3100/setup` (pakai port Anda kalau sudah diganti) lalu isi:

- kode setup;
- alamat email Anda (hanya dipakai sebagai nama sign-in; Watchbell tidak mengirim email ke alamat itu kecuali Anda
  menyiapkan [ringkasan email](notifications.md#ringkasan-email-harian));
- password minimal 12 karakter, dua kali.

Begitu owner dibuat, kodenya dihapus, `app/data/setup-code` dihapus, dan `/setup` tidak ada lagi.

## 3. Pasang authenticator

Owner dan operator bisa mengubah infrastruktur, jadi sign-in mereka butuh faktor kedua. Tepat setelah setup, Watchbell
menampilkan QR code:

1. Scan dengan aplikasi authenticator (aplikasi TOTP apa pun bisa: Google Authenticator, Microsoft Authenticator,
   Aegis, 1Password, Bitwarden, dan lainnya). Kalau tidak bisa scan, ketik key yang ditampilkan di bawah QR code.
2. Ketik kode 6 digit yang ditampilkan aplikasinya.

Mulai sekarang Anda sign in di `/signin` dengan email dan password, lalu kode 6 digit. Simpan authenticator di
perangkat yang tidak akan hilang, atau simpan key-nya di password manager.

## 4. Hubungkan sesuatu

Console terbuka di halaman welcome yang berisi langkah-langkah awal: hubungkan Vercel, pilih aplikasi yang mau
dipantau, tambahkan database Anda. Lihat [Menghubungkan provider](providers.md) untuk setiap token dan izinnya, lalu
[Notifikasi](notifications.md) agar alert masuk ke ponsel Anda.

## Menambah orang lain

Settings › Users (khusus owner) menambahkan member lewat email dengan sebuah role:

| Role | Bisa melakukan |
|---|---|
| Owner | Semuanya, termasuk connection, user, dan pengaturan. |
| Operator | Melihat semuanya dan bisa redeploy, restore, wake, dan men-silence alert. |
| Viewer | Read-only. Tanpa log dan tanpa aksi. |

Watchbell tidak mengirim email undangan. Ia membuat akun dengan password sementara yang ditampilkan sekali; berikan
sendiri password itu kepada orangnya. Mereka memilih password sendiri saat sign-in pertama, lalu owner dan operator
memasang authenticator. Orang lain hanya bisa menjangkau Watchbell kalau ia mendengarkan di jaringan Anda (lihat
[Akses LAN](configuration.md#akses-lan)).

## Tidak bisa masuk

Kalau Anda lupa password atau kehilangan authenticator, reset login dari mesin tempat Watchbell berjalan:

1. Hentikan Watchbell: `systemctl --user stop watchbell` (service Linux), `npm run stop:selfhost` di folder `app`
   (task Windows, atau cara jalan apa pun), atau Ctrl+C di terminal yang menjalankannya.
2. Di folder `app`, jalankan:

   ```bash
   npm run reset-login -- you@example.com
   ```

3. Perintah ini menampilkan password sementara yang berlaku 7 hari. Perintah ini juga menghapus authenticator akun
   tersebut dan mengakhiri session-nya.
4. Jalankan Watchbell lagi, sign in dengan password sementara, pilih password baru, lalu pasang authenticator lagi.

`reset-login` bisa dipakai untuk akun mana pun di Watchbell ini, bukan hanya owner. Perintah ini menolak jalan selama
Watchbell masih berjalan ("Watchbell is running on …. Stop Watchbell first"). Ia membaca `WATCHBELL_DATA_DIR` dari
shell, bukan dari `app/.env`, jadi kalau Anda memindahkan folder data, set dulu variabel itu
(`WATCHBELL_DATA_DIR=/path/to/data npm run reset-login -- you@example.com`).
Perintah ini juga menghapus waktu tunggu sign-in setelah password salah untuk semua akun (di belakang reverse proxy,
waktu tunggu itu disimpan per email dan alamat sekaligus, jadi tidak bisa dihapus hanya untuk satu email).

## Kalau kode setup tidak bisa dipakai

- **"That setup code is wrong"**: salin lagi dari `app/data/setup-code` atau dari baris log terbaru. Kode lama dari
  start sebelumnya sudah tidak berlaku.
- **"That setup code has expired"**: restart Watchbell untuk mendapat kode baru.
- **"Too many wrong codes"**: tunggu selama waktu yang ditampilkan, atau restart Watchbell.
- **`/setup` menampilkan "not found"**: owner sudah ada. Sign in di `/signin`, atau pakai `reset-login` di atas.

Selengkapnya di [Troubleshooting](troubleshooting.md).
