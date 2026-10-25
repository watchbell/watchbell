# FAQ

English: [../faq.md](../faq.md)

### Apakah Watchbell berbayar?

Tidak. Watchbell gratis dan open source (MIT). Ia berjalan di mesin Anda sendiri dan tidak butuh akun di mana pun untuk
mulai. Provider yang dipantaunya adalah akun milik Anda sendiri; Watchbell dirancang di sekitar paket gratis mereka dan
membacanya lewat API mereka. Fitur AI memakai key AI provider milik Anda sendiri, dan ringkasan email memakai akun
Resend Anda sendiri.

### Apakah data saya keluar dari mesin saya?

Data Anda tetap di `app/data` di mesin Anda. Watchbell hanya berkomunikasi dengan provider yang Anda hubungkan (untuk
membacanya dan, saat Anda minta, untuk bertindak), dengan layanan notifikasi yang Anda siapkan, dengan AI provider dan
Google Drive Anda kalau Anda menyiapkannya, serta dengan status page publik dan RDAP untuk tanggal kedaluwarsa domain.
Tidak ada telemetri dan tidak ada yang dikirim ke proyek Watchbell.

Satu-satunya request atas inisiatifnya sendiri ada di paket npm: `watchbell` dan `watchbell status` bertanya ke
registry.npmjs.org paling banyak sekali sehari apakah ada versi yang lebih baru. Itu request biasa untuk nomor versi,
tanpa id dan tanpa informasi apa pun tentang Anda atau instalasi Anda, dan `WATCHBELL_NO_UPDATE_CHECK=1` (atau
`NO_UPDATE_NOTIFIER=1`, atau `CI`) mematikannya.

### Bisakah saya menjalankannya di server, bukan di laptop?

Bisa. Installer yang sama bisa dipakai di server Linux. Jalankan `loginctl enable-linger "$USER"` agar service tetap
berjalan tanpa session login, dan pakai reverse proxy dengan HTTPS kalau Anda ingin menjangkaunya dari tempat lain
(lihat [Di belakang reverse proxy](configuration.md#di-belakang-reverse-proxy)).

### Apa yang terjadi saat laptop saya sleep atau mati?

Tidak ada yang dicek selama Watchbell tidak berjalan. Saat ia kembali, collector mengejar ketertinggalan, job harian
yang terlewat dijalankan sekali, dan tekanan tombol Telegram yang dilakukan sementara itu diproses. Untuk pengecekan
sepanjang waktu, jalankan di mesin yang selalu menyala.

### Apakah ada Docker image?

Belum. Pakai installer atau [langkah manual](install.md#macos-dan-instalasi-manual).

### Apakah ada installer untuk macOS?

Tidak; ikuti [langkah manual](install.md#macos-dan-instalasi-manual). Hanya butuh beberapa menit.

### Bisakah beberapa orang memakai satu Watchbell?

Bisa. Owner menambahkan member dengan role owner, operator, atau viewer di Settings › Users (lihat
[Menambah orang lain](first-run.md#menambah-orang-lain)). Mereka perlu bisa menjangkau mesinnya, jadi Anda butuh
[akses LAN](configuration.md#akses-lan) atau reverse proxy.

### Bisakah saya memakainya dari ponsel?

Telegram adalah cara termudah: alert serta tombol approve/reject bisa dipakai dari mana saja, walaupun Watchbell
berjalan di laptop Anda. Membuka console-nya sendiri dari ponsel butuh [akses LAN](configuration.md#akses-lan) di
jaringan yang sama, atau reverse proxy.

### Hosting provider apa saja yang didukung?

Aplikasi di Vercel; database di Supabase, Neon, Firebase (Firestore), Turso, Upstash Redis, dan Cloudflare D1; domain
dan DNS di Cloudflare; repository di GitHub. Pengecekan uptime dan heartbeat menempel pada aplikasi
yang dipantau: hubungkan Vercel, Sync, dan centang sebuah aplikasi dulu, baru tambahkan pengecekan untuk alamat HTTP
apa pun dan heartbeat untuk job apa pun yang bisa mengirim request HTTP ke Watchbell.

### Bisakah heartbeat dari cron job saya sampai ke laptop?

Hanya kalau job-nya bisa menjangkau alamat Watchbell. Job di mesin yang sama bisa memanggil
`http://localhost:3100/api/ping/<token>`. Job di tempat lain butuh console yang bisa dijangkau (akses LAN atau reverse
proxy).

### Zona waktu apa yang dipakai Watchbell?

Zona di `WATCHBELL_TIMEZONE` dalam `.env` Anda, sebuah nama IANA seperti `Europe/Berlin`. Hanya instalasi baru yang
mendapat zona komputer Anda: installer dan npm CLI menuliskannya saat membuat file itu. Instalasi yang di-upgrade
mempertahankan `.env`-nya sehingga tetap memakai WIB sampai Anda menambahkan pengaturan ini, dan `.env` yang disalin
manual dari `.env.example` juga harus men-set-nya. Ubah lalu restart Watchbell untuk memakai zona lain. Setiap waktu di
console dan di pesan ditampilkan dalam zona itu, dan jadwal mengikuti jamnya, termasuk daylight saving: job harian
pukul 03:00, ringkasan email pukul 07:00, advisor notes pukul 07:00 dan 19:00. Tanpa pengaturan ini (instalasi dari
sebelum 1.1), zonanya adalah Waktu Indonesia Barat (WIB, `Asia/Jakarta`), tempat Watchbell pertama kali ditulis. Lihat
[Konfigurasi](configuration.md#zona-waktu).

### Bisakah saya mengganti bahasanya?

Pesan yang dikirim ke Telegram, Discord, dan email bisa dalam bahasa Inggris atau Bahasa Indonesia, per channel.
Console-nya sendiri dalam bahasa Inggris.

### Saya kehilangan OPS_ENCRYPTION_KEY. Sekarang bagaimana?

Token dan secret authenticator yang tersimpan tidak bisa didekripsi tanpa key itu. Taruh key baru di `app/.env`,
restart, ganti setiap credential di Connections, hubungkan ulang Google Drive, dan reset setiap owner dan operator
dengan `npm run reset-login -- <email>` supaya mereka bisa memasang authenticator lagi. Riwayat Anda (event, uptime,
alert) tetap tersimpan. Lihat [Backup](backups.md#kenapa-appenv-penting).

### Bagaimana cara update?

Dengan paket npm: `watchbell update` (lihat [Instalasi cepat dengan npm](install.md#instalasi-cepat-dengan-npm)). Dari
1.0.x, update sekali secara manual, karena 1.0 belum punya `watchbell update`: `watchbell stop` (atau hentikan
service-nya), lalu `npm install -g watchbell@latest`. Dengan installer: lihat [Upgrade](install.md#upgrade).

### Bagaimana cara melaporkan bug atau masalah keamanan?

Bug: buka issue di GitHub. Masalah keamanan: laporkan secara privat, seperti dijelaskan di
[kebijakan keamanan](../../SECURITY.md).

### Apakah ada demo?

Tidak, tidak ada demo online. Screenshot di [README](../../README.md) semuanya berasal dari mode demo Watchbell,
dengan data karangan. Untuk mencoba Watchbell sendiri, [pasang](install.md): gratis dan jalan di mesinmu sendiri.
