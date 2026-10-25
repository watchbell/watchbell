# Halaman

English: [../pages.md](../pages.md)

Menu kiri mengelompokkan halaman ke dalam bagian, sama seperti di console: Home, Hosting, Database, DevOps, dan Manage.
Home, Hosting, dan Manage sudah ada sejak awal. Database muncul dengan sendirinya saat Anda menghubungkan Supabase,
Neon, Firebase, Turso, atau Upstash, atau begitu ada database yang dipantau; DevOps saat Anda menghubungkan GitHub.
Owner bisa mematikan Hosting, Database, atau DevOps di [Manage › Sections](#manage). Beberapa halaman khusus owner;
operator dan viewer tidak melihatnya di menu (lihat [role](first-run.md#menambah-orang-lain)). Tekan Ctrl+K (Cmd+K di
Mac) di mana saja untuk langsung pindah ke halaman berdasarkan namanya; daftarnya sama dengan halaman di menu.

Watchbell membaca provider Anda dengan jadwalnya sendiri: collector berjalan setiap menit (tiap task hanya kalau
interval-nya sendiri sudah lewat) dan job harian pukul 03:00 di [zona waktu](configuration.md#zona-waktu) Anda. Tidak
ada yang berjalan selama mesin sedang sleep atau Watchbell sedang berhenti; job harian yang terlewat dijalankan sekali
saat Watchbell kembali. Waktu di halaman-halaman ini dan di pesan memakai zona tersebut.

- [Home](#home)
- [Hosting](#hosting)
- [Database](#database)
- [DevOps](#devops)
- [Manage](#manage)
- [Halaman di luar menu](#halaman-di-luar-menu)

## Home

**Welcome.** Ditampilkan selama belum ada yang terhubung: langkah-langkah awal (hubungkan Vercel, pilih aplikasi yang
mau dipantau, tambahkan database Anda), masing-masing dicentang begitu Anda menyelesaikannya.

**Overview.** Kondisi semuanya dalam sekali lihat: banner untuk connection yang perlu diperhatikan dan untuk masalah
yang ditemukan collector, create request yang menunggu approval, dan setiap aplikasi yang dipantau beserta uptime,
deployment terakhir, dan database yang terhubung. Operator dan owner mendapat tombol Refresh yang langsung menjalankan
collector.

**Topology.** Peta yang menunjukkan bagaimana setiap domain sampai ke sebuah aplikasi dan database mana yang dipakai
tiap aplikasi. Domain diambil dari Vercel; hubungan ke database diambil dari link Edit di tiap aplikasi. Pilih sebuah
node untuk melihat detailnya.

**Events.** Setiap perubahan yang dicatat collector dan setiap aksi yang dilakukan seseorang, dari yang terbaru. Event
baru muncul selama halaman terbuka; perubahan yang berulang dalam satu jam dihitung di satu baris. Halaman ini juga
berfungsi sebagai audit log: approval, auto-run, perubahan yang berkaitan dengan sign-in, dan perubahan pengaturan
tercatat di sini.

**Provider status.** Feed status publik dari Vercel, Supabase, Neon, Cloudflare, Firebase, dan Google Cloud, diambil
setiap 5 menit. Saat sebuah provider mengalami insiden, alert yang berkaitan diberi label supaya Anda tahu masalahnya
bukan di aplikasi Anda.

## Hosting

**Applications.** Project Vercel yang Anda pilih untuk dipantau, beserta database, domain, dan uptime-nya. Buka salah
satunya untuk melihat:

- Detail: status, response time, page view, response 5xx, uptime, security advisory untuk dependency-nya, serta
  repository GitHub dan status Actions-nya kalau GitHub sudah terhubung. Kartu Security menampilkan versi Next.js yang
  dijalankan situs live beserta advisory yang diketahui, dicek setiap 6 jam dan tepat setelah setiap deployment
  production baru; versi yang rentan memunculkan alert FrameworkVulnerable dan, dengan repository yang ditautkan, usulan
  pull request update (lihat [Auto-actions](auto-actions.md#alert-mana-mengusulkan-apa)). Di monorepo, kartu
  Dependencies men-scan Root Directory project Vercel (misalnya `apps/web/package-lock.json`), dan Scan now men-scan
  folder aplikasi itu. "None known" hanya muncul setelah scan berhasil; kalau tidak, kartunya menulis **Not scanned**
  beserta alasannya (belum ada repository yang ditautkan, DevOps mati, tidak ada lockfile atau package.json, atau scan
  gagal).
- Tab Metrics, Deployments, dan Logs untuk aplikasi itu.
- Aksi untuk operator dan owner: redeploy, roll back, check now. Menu baris di daftar Applications juga punya Redeploy
  (dengan konfirmasi yang sama) dan View logs (tab Logs aplikasi itu).

**Deployments.** Deployment terbaru dari aplikasi yang dipantau, dibaca dari Vercel API. Paket gratis Hobby di Vercel
hanya bisa roll back ke deployment production sebelumnya. **View build logs** (operator dan owner: tombol pada deployment
yang sedang building atau gagal, di menu baris untuk deployment yang ready) membuka log build terbaru di drawer samping,
dibaca dari Vercel saat Anda membukanya (2.000 baris terakhir, tidak disimpan), dengan baris error disorot dan link
"Jump to first error".

**Domains.** Setiap domain dari aplikasi yang dipantau: DNS dari Cloudflare, konfigurasi dari Vercel, tanggal
kedaluwarsa registrasi dari RDAP, dan tanggal kedaluwarsa sertifikat dari pengecekan TLS milik Watchbell sendiri.
Memberi peringatan kalau sebuah domain di-proxy lewat Cloudflare di depan Vercel dan, untuk owner, menawarkan tombol
sekali klik "Set DNS only". Re-check membaca ulang sertifikat.

**DNS records.** Record dari setiap zone Cloudflare yang Anda pantau, beserta detail zone-nya. Owner bisa mengedit
record atau menambahkan record (sebagai create request, lihat di bawah); keduanya butuh izin DNS Edit pada token
Cloudflare. Record tidak pernah dihapus dari sini.

**Uptime.** Pengecekan HTTP (setiap menit) dan heartbeat. Heartbeat menunggu job Anda sendiri memanggil alamat ping-nya,
`<SITE_URL>/api/ping/<token>` (tambahkan `/start` atau `/fail` untuk melaporkan status itu), dan membuat alert kalau
ping-nya terlambat. Di sini juga ada maintenance window (sekali saja atau mingguan): pengecekan tetap berjalan di dalam
window, tetapi tidak membuka alert dan tidak dihitung dalam uptime. Kalau aplikasi pindah ke domain baru, pengecekan
yang masih ke domain lama tampil **Domain changed: lama → baru** (di sini dan di halaman aplikasi), bukan Down, dan
Owner serta Operator mendapat tombol **Update monitor** yang mengarahkan pengecekan ke domain baru dengan path yang sama.
Ini hanya terjadi kalau domain lama dulu tercantum di project Vercel, atau Vercel sendiri menjawab bahwa tidak ada
deployment yang melayaninya; pengecekan ke server lain tetap Down seperti biasa.
Watchbell membaca domain aplikasi setiap 6 jam, atau langsung saat Anda menekan Sync; domain tempat production dilayani
menjadi Domain aplikasi.

**Logs** (tidak untuk viewer). Dua tab: request log satu jam terakhir dari Vercel, dan error yang tersimpan. Paket
gratis Vercel hanya menyimpan riwayat singkat, jadi collector menyalin warning dan error setiap 5 menit dan
menyimpannya selama 7 hari.

## Database

**Supabase.** Status, region, dan versi Postgres tiap project dari Management API, yang tidak menyentuh database Anda.
Ukuran database dibaca sekali sehari, dan hanya selama project-nya memang sedang aktif. Per project (khusus owner):
**Keep active** memberi peringatan mulai hari ke-5 tanpa trafik API dan mengirim satu query keep-alive per hari agar
project gratis tidak di-pause; **Auto-restore** menghidupkan kembali project yang di-pause saat akunnya punya slot
gratis. **Check services** di menu baris langsung membaca kesehatan layanan project (Auth, REST, Realtime, Storage,
Database) dari Management API.

**Neon.** Status compute, CU-hour, storage, dan transfer dari Neon API. Membaca data itu tidak membangunkan compute dan
Watchbell tidak pernah terhubung ke database-nya. Operator bisa membangunkan compute yang sedang suspended.

**Firebase.** Kesehatan Firestore dan jumlah user Auth tiap project. Firestore tidak punya status running atau stopped,
jadi setiap 5 menit collector membaca satu dokumen health (288 dari 50.000 read gratis per hari); **Run health check**
di menu baris langsung melakukan pembacaan itu. Read, write, dan delete hari ini berasal dari Cloud Monitoring, yang
butuh billing (Blaze): di paket gratis Spark barisnya menyebutkan bahwa data itu tidak tersedia; di Blaze data itu dibaca
setiap jam. Ukuran data yang tersimpan tidak dibaca di paket apa pun; link Open usage page menampilkannya (beserta
pemakaian hari itu) di Firebase console.

**Turso.** Database, row read dan row written, serta storage bulan ini dari Turso Platform API, dibaca setiap jam.
Batas gratisnya berlaku per organisasi, jadi meter-nya menampilkan total organisasi.

**Upstash Redis.** Region, command dan bandwidth bulan ini, serta ukuran data dari Upstash Developer API, dibaca setiap
jam dengan key read-only. Watchbell tidak pernah terhubung langsung ke Redis.

**Cloudflare D1.** Ukuran dari D1 API serta row read dan row written hari ini (UTC) dari analytics Cloudflare, dibaca
setiap jam dengan token Cloudflare. Watchbell tidak pernah menjalankan query di database D1.

**SQL console** (khusus owner). Query read-only ke database Supabase dan Neon Anda, serta query builder untuk
Firestore. Lihat [SQL console](sql-console.md).

**Free databases.** Katalog database hosted yang bisa Anda pakai gratis, dicocokkan dengan halaman harga resminya,
beserta apa saja yang bisa dipantau Watchbell untuk masing-masing.

**Create requests.** Halaman Supabase, Neon, Firebase, dan DNS records bisa meminta pembuatan sesuatu yang baru
(project, database, record). Request diperiksa dulu dan baru dijalankan setelah owner menyetujuinya; request yang
menunggu approval juga tampil di Overview. Pembuatan butuh token dengan akses tulis untuk provider tersebut (lihat
[Menghubungkan provider](providers.md)).

## DevOps

Di bawah sub-judul **Automation**:

**Repositories.** Browser read-only untuk repository yang bisa dibaca token GitHub Anda: README, file, commit, branch,
run Actions, dan dependency advisory. Menampilkan "GitHub isn't connected" sampai Anda menambahkan token GitHub.

## Manage

**Connections** (khusus owner). Akun provider yang dibaca Watchbell: Vercel, Supabase, Neon, Firebase, Turso, Upstash,
Cloudflare, GitHub, dan token GitHub PR-write yang opsional, berupa tile yang dikelompokkan per bagian (Hosting,
Database, DevOps, dan Google Drive di bawah Manage). Sebuah tile membuka drawer berisi akun-akun provider itu dan form
untuk menambahkan akun. Token dienkripsi (AES-256-GCM) dengan `OPS_ENCRYPTION_KEY` sebelum disimpan dan tidak pernah
sampai ke browser. **Sync** menampilkan semua isi sebuah akun dan Anda mencentang apa saja yang mau dipantau. Banner di
bagian atas menampilkan connection yang berhenti bekerja. Lihat [Menghubungkan provider](providers.md).

**Alerts.** Tiga tab:

- Firing: apa yang sedang bermasalah sekarang, dan apa yang sudah resolved dalam 7 hari terakhir. Operator bisa
  men-silence alert untuk sementara.
- Rules: rule bawaan (aplikasi down atau lambat, deployment gagal, database yang di-pause atau hampir penuh, domain atau
  sertifikat yang hampir kedaluwarsa, token yang akan kedaluwarsa, dependency atau versi Next.js yang
  rentan, collector yang tidak berjalan, dan lainnya), beserta threshold-nya. Rule dijalankan setelah setiap run collector, dan data yang tidak
  diketahui tidak pernah membuka atau me-resolve alert.
- Notifications: ke mana alert dikirim. Lihat [Notifikasi](notifications.md).

**Auto-actions** (khusus owner). Perbaikan yang diusulkan Watchbell untuk alert yang sedang firing, yang menunggu
approval Anda, serta riwayat apa saja yang sudah dijalankan. Lihat [Auto-actions](auto-actions.md).

**Sections** (khusus owner). Setiap bagian dengan sakelar yang menunjukkan apakah bagian itu ada di menu, plus satu
baris tentang isinya. Home dan Manage selalu aktif. Database atau DevOps yang belum punya apa pun yang terhubung tampil
mati dan tidak bisa dinyalakan; barisnya menyebutkan apa yang perlu dihubungkan. Mematikan Hosting, Database, atau
DevOps (setelah langkah konfirmasi; untuk Hosting disebutkan bahwa semua pengecekan uptime dan heartbeat berhenti)
menyembunyikannya dari menu dan menjeda task collector, rule alert, notifikasi, serta usulan auto-action baru untuk
bagian itu. Datanya tetap disimpan, halamannya tetap bisa dibuka dari link, dan alert yang sedang firing tetap seperti
apa adanya (tidak ditampilkan di lonceng, halaman Alerts, dan API) sampai Anda menyalakannya lagi; pemberitahuan yang
tertunda dikirim pada run berikutnya. Keep active dan Auto-restore tetap berjalan selama Database mati, jadi project
Supabase yang dijaga tidak pernah di-pause gara-gara sakelar ini.

**Settings** (khusus owner). Tab-tabnya:

- Collector: seberapa sering tiap task collector berjalan, dan catatan keep-alive database.
- Free tier budget: batas paket gratis yang dipakai sebagai pembanding oleh meter. Koreksi di sini kalau sebuah
  provider mengubah paket gratisnya. Slot Supabase, CU-hour Neon, QStash, dan cron-job.org menampilkan apa yang dibaca
  Watchbell; pemakaian bulanan Vercel dan jumlah event Web Analytics tidak dibaca, jadi baris itu menulis "not read"
  (lihat Usage di dashboard Vercel).
- Users: member dan role-nya (lihat [Menambah orang lain](first-run.md#menambah-orang-lain)).
- Retention: berapa lama Watchbell menyimpan riwayatnya sendiri (event, pengecekan, rollup). Tidak ada yang pernah
  dihapus di provider.
- Status page: halaman publik di `/s/<address>` dengan satu baris di atas yang menyatakan apakah semuanya berjalan
  (atau layanan mana yang bermasalah), nama yang Anda pilih, kondisi saat ini, bar 90 hari, dan pemberitahuan
  maintenance. Badge uptime untuk README ada di tab ini, tidak di halaman publik. Halaman ini tidak pernah menampilkan
  alamat, teks error, atau nama provider. Nonaktif sampai Anda mempublikasikannya; alamat yang tidak dikenal atau belum
  dipublikasikan menampilkan "No status page here" saja.
- Lockfile: workflow GitHub Actions opsional di repository kecil milik Anda sendiri yang membuat `package-lock.json`
  untuk pull request update (lihat [Auto-actions](auto-actions.md#perbaikan-keamanan-otomatis)).
- Auto-actions: aksi aman mana yang boleh berjalan tanpa bertanya, auto-rollback, dan perbaikan keamanan otomatis.

**AI Gateway** (khusus owner). AI provider milik Anda sendiri dan API untuk aplikasi serta agent Anda, dengan menu
sendiri: Overview, Usage, Ask, API keys, Agents, Connect an agent, Bring your own key, Quota, Logs, Models, dan
Playground. Lihat [AI](ai.md).

**API explorer** (khusus owner). Setiap endpoint API Watchbell (`/api/v1`) dari satu file OpenAPI 3.1. Coba sebuah
request dengan console API key; request itu dijalankan ke Watchbell ini dengan scope dan rate limit milik key
tersebut.

**Backups** (khusus owner). Ringkasan bulanan yang disimpan ke Google Drive Anda. Lihat [Backup](backups.md).

**Status page** (khusus owner). Membuka tab Status page di Settings (di atas).

## Halaman di luar menu

- `/signin`, `/mfa`: sign-in dan langkah authenticator.
- `/setup`: halaman untuk pertama kali dijalankan; hilang begitu owner sudah ada.
- `/account/password`: mengganti password Anda sendiri (Anda harus sudah sign in dan melewati langkah authenticator).
  Member yang ditambahkan owner dengan password sementara diarahkan ke sini lebih dulu setelah sign in dan tidak bisa
  memakai console sampai mereka memilih password sendiri; password sementara juga berhenti berlaku setelah 7 hari.
- `/invite`: tempat orang dengan undangan yang masih terbuka mendarat setelah sign in, untuk menerimanya dengan role
  yang disebut di undangan itu. Di mode self-host, owner menambahkan member langsung dari Settings (Add member), jadi
  biasanya Anda tidak akan melihat halaman ini.
- `/s/<address>`: status page publik Anda, kalau Anda sudah mempublikasikannya.
- `/api/health`: menjawab `{"ok":true}` selama console berjalan. Arahkan uptime checker dari luar ke sini kalau
  Watchbell bisa dijangkau dari luar.
