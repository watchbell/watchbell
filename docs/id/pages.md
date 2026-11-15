# Halaman

English: [../pages.md](../pages.md)

Menu kiri mengelompokkan halaman ke dalam bagian, sama seperti di console: Home, Hosting, Database, DevOps, dan Manage.
Home, Hosting, dan Manage sudah ada sejak awal. Database muncul dengan sendirinya saat Anda menghubungkan Supabase,
Neon, Firebase, Turso, atau Upstash, atau begitu ada database yang dipantau; DevOps saat Anda menghubungkan GitHub, dan
selalu ada di console self-hosted (Containers dan OS vulnerabilities di dalamnya tidak butuh GitHub).
Owner bisa mematikan Hosting, Database, atau DevOps di [Manage › Sections](#manage). Beberapa halaman khusus owner;
operator dan viewer tidak melihatnya di menu (lihat [role](first-run.md#menambah-orang-lain)). Tekan Ctrl+K (Cmd+K di
Mac) di mana saja untuk langsung pindah ke halaman berdasarkan namanya; daftarnya sama dengan halaman di menu.

Watchbell membaca provider Anda dengan jadwalnya sendiri: collector berjalan setiap menit (tiap task hanya kalau
interval-nya sendiri sudah lewat) dan job harian pukul 03:00 di [zona waktu](configuration.md#zona-waktu) Anda. Tidak
ada yang berjalan selama mesin sedang sleep atau Watchbell sedang berhenti; job harian yang terlewat dijalankan sekali
saat Watchbell kembali. Waktu di halaman-halaman ini dan di pesan memakai zona tersebut.

Top bar menulis kapan data halaman terakhir datang ("Updated 12s ago · Auto · after each check"). Klik untuk memilih
cara halaman diperbarui: **Auto** (bawaan, tepat setelah setiap run collector), setiap 1, 5, 15, atau 30 menit, atau
**Off**. Pilihan disimpan di browser ini. Tab yang tersembunyi tidak diperbarui dan menyusul begitu Anda kembali; tab
yang tidak disentuh selama 30 menit diperbarui paling sering setiap 4 menit.

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

Kartu Health merangkum 24 jam terakhir dengan bahasa sehari-hari: **Sites reachable** (berapa persen pengecekan yang
dijawab, yaitu uptime), **Response time** (kebanyakan pengecekan, 95 dari 100, dijawab lebih cepat dari angka ini:
p95), **Server errors** (halaman yang rusak di sisi server: respons HTTP 5xx), dan **New versions** (deploy yang naik
ke production). Hitungannya ditulis "in 24 h" karena jendelanya 24 jam terakhir, bukan hari kalender. Arahkan kursor ke
barisnya untuk melihat nama teknisnya. Saat tag sumber data dinyalakan, badge-nya berbunyi **Checked by Watchbell**
atau **From Vercel**. Sel Neon di atasnya menulis "is asleep" untuk compute yang idle dan menghitung "compute hours used
this month".

**Topology.** Peta yang menunjukkan bagaimana setiap domain sampai ke sebuah aplikasi dan database mana yang dipakai
tiap aplikasi. Domain diambil dari Vercel; hubungan ke database diambil dari link Edit di tiap aplikasi. Pilih sebuah
node untuk melihat detailnya.

**Events.** Setiap perubahan yang dicatat collector dan setiap aksi yang dilakukan seseorang, dari yang terbaru. Event
baru muncul selama halaman terbuka; perubahan yang berulang dalam satu jam dihitung di satu baris. Halaman ini juga
berfungsi sebagai audit log: approval, auto-run, perubahan yang berkaitan dengan sign-in, dan perubahan pengaturan
tercatat di sini.

**Provider status.** Feed status publik dari Vercel, Supabase, Neon, Cloudflare, Firebase, dan Google Cloud, diambil
setiap 5 menit. Saat sebuah provider mengalami insiden, alert yang berkaitan diberi label supaya Anda tahu masalahnya
bukan di aplikasi Anda. Setiap insiden menyebut apa yang terdampak. Insiden pada sesuatu yang tidak dipantau Watchbell
(Firebase Test Lab, dashboard atau Management API Supabase) tampil abu-abu dan tidak memunculkan apa pun; hanya
Firestore, Authentication, dan Hosting yang mewarnai Firebase, dan hanya project dan database yang mewarnai Supabase.
Insiden yang feed-nya tidak berubah lebih dari sehari ditandai "no update for N days, may be stale".

## Hosting

Menu Hosting dikelompokkan ke **Apps** (Applications, Deployments, Deploy an app), **Network** (Domains, DNS
records), dan **Watch** (Uptime, Logs).

**Deploy an app.** Pilih bahasa yang dipakai app (Next.js, situs statis, Node.js, Python, PHP, Go, Java, .NET, Ruby,
atau image Docker), lalu tempat menjalankannya: host gratis lebih dulu, lalu gratis dengan kartu, trial, paket
berbayar, dan panduan untuk cloud besar. Setiap host menampilkan catatannya dalam satu baris (tidur saat idle, hanya
non-komersial, perlu kartu) dan apa yang bisa Watchbell lakukan setelahnya. Daftarnya dicek terhadap halaman harga
resmi tiap host dan tanggalnya tertulis di halaman. Pilih repository (bahasa GitHub-nya memilih tile) dan tombolnya
membuka halaman project baru milik host itu sendiri; Watchbell tidak men-deploy apa pun dan tidak pernah memasukkan
repository Anda ke link-nya (link "deploy" milik host menyalinnya menjadi repository baru). Vercel perlu dihubungkan
dulu; project Vercel baru muncul di Sync pada halaman Connections setelah sync berikutnya (harian, atau Sync now), lalu
centang untuk memantaunya (atau nyalakan Watch new ones automatically). Host lain, termasuk Cloudflare, bisa dipantau
lewat Uptime. Di bawahnya, **Where your apps run** menampilkan aplikasi Anda beserta statusnya. Untuk owner dan operator;
viewer tidak melihat halaman ini.

**Applications.** Project Vercel yang Anda pilih untuk dipantau, beserta database, domain, dan uptime-nya. Buka salah
satunya untuk melihat:

- Detail: status, response time, page view, response 5xx, uptime, security advisory untuk dependency-nya, serta
  repository GitHub dan status Actions-nya kalau GitHub sudah terhubung. Kartu Security menampilkan versi Next.js yang
  dijalankan situs live beserta advisory yang diketahui, dicek setiap 6 jam dan tepat setelah production mulai
  melayani deployment lain (deploy baru, promote, atau roll back); versi yang rentan memunculkan alert FrameworkVulnerable dan, dengan repository yang ditautkan, usulan
  pull request update (lihat [Auto-actions](auto-actions.md#alert-mana-mengusulkan-apa)). Node.js tempat Watchbell
  sendiri berjalan dicek di Settings › Collector (Watchbell runtime). Di monorepo, kartu
  Dependencies men-scan Root Directory project Vercel (misalnya `apps/web/package-lock.json`), dan Scan now men-scan
  folder aplikasi itu. "None known" hanya muncul setelah scan berhasil; kalau tidak, kartunya menulis **Not scanned**
  beserta alasannya (belum ada repository yang ditautkan, DevOps mati, tidak ada lockfile atau package.json, atau scan
  gagal). Advisory yang hanya ada di alat development (paket yang tidak pernah ikut ke production, misalnya alat
  migrasi) dihitung terpisah di baris **Development tools**, ditandai "local development only, no production impact",
  dan tidak pernah memunculkan alert.
- Kartu Environment (operator dan owner), di bawah Dependencies. **Check now** membaca nama-nama environment variable
  project dari Vercel lalu membandingkannya dengan `.env.example` di repository yang ditautkan (di Root Directory, pada
  branch default). Kartunya mencantumkan nama yang ada di `.env.example` tapi tidak diset untuk Production, nama yang
  hanya diset untuk Preview atau Development, nama `NEXT_PUBLIC_` yang terlihat rahasia (nilainya ikut ke browser), dan
  nama Production yang tidak ada di `.env.example`. Yang dibaca hanya nama, tidak pernah nilainya; tidak ada yang
  berjalan terjadwal dan tidak ada yang disimpan. Kalau GitHub belum terhubung, kartunya menyebut itu dan hanya memeriksa
  pengaturan Vercel.
- Kartu Pull requests (operator dan owner, aplikasi dengan repository yang ditautkan). **Check open pull requests**
  membaca pull request yang masih terbuka di repository itu dan komentar [pre-deploy check](precheck.md) di tiap pull
  request: fix before merging, check before merging, no new problems, checked an older commit, not checked
  (repository-nya belum menjalankan pengecekan ini), atau couldn't read the comments (GitHub tidak menjawab; coba lagi).
  Tidak ada yang berjalan terjadwal dan tidak ada yang disimpan. Kalau run GitHub Actions terakhir di branch default
  repository itu gagal, alert **CiFailing** menyala (warning); alert itu resolved di run berikutnya yang lolos. Yang
  dilihat adalah run terakhir dari workflow apa pun di sana, bukan hanya workflow bernama CI. Watchbell membaca run itu
  saat sync GitHub harian, jadi token GitHub-nya perlu izin Actions: Read; run yang tidak terbaca lagi selama dua hari
  dianggap tidak diketahui, jadi alert-nya tidak menyala dan tidak resolved karena data lama.
- Kartu Build files (operator dan owner). **Generate** menulis `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
  workflow GitHub Actions (`.github/workflows/ci.yml`), dan manifest Kubernetes (`k8s.yaml`) dari pengaturan aplikasi:
  framework-nya (Next.js, Vite, Create React App, atau aplikasi Node yang punya script start), Root Directory Vercel,
  package manager dari lockfile, versi Node di `engines`, script-nya, dan nama env-nya (hanya nama, tidak pernah nilai).
  Tiap file punya tombol Copy; fakta yang harus ditebak Watchbell dicantumkan. Owner bisa menekan **Open pull request**:
  file-file itu masuk ke branch baru `watchbell/build-files-…` di repository yang ditautkan, dan file yang sudah ada di
  repository tidak pernah ditimpa (dicantumkan sebagai dibiarkan). File CI butuh izin Workflows: Read and write pada
  token PR-write; tanpa izin itu pull request tetap dibuka tanpa file tersebut dan menyebutkannya. Manifest Kubernetes
  tidak berisi Secret: komentarnya memuat perintah `kubectl create secret … --from-env-file=.env` dan nama-nama env.
  Tidak ada yang di-build, di-deploy, atau disimpan.
- Tab Metrics, Deployments, dan Logs untuk aplikasi itu.
- Aksi untuk operator dan owner: redeploy, roll back, check now. Menu baris di daftar Applications juga punya Redeploy
  (dengan konfirmasi yang sama) dan View logs (tab Logs aplikasi itu).

**Deployments.** Deployment terbaru dari aplikasi yang dipantau, dibaca dari Vercel API. Paket gratis Hobby di Vercel
hanya bisa roll back ke deployment production sebelumnya. **Current** menandai deployment yang dilayani production,
dan Last deploy (Overview, Applications, halaman aplikasi) menampilkan deployment itu, juga setelah promote atau roll
back ke deployment yang lebih lama; build production yang lebih baru dan masih building atau gagal ditampilkan di sana
sebagai gantinya. Waktunya adalah saat build itu dibuat, bukan saat di-promote. **View build logs** (operator dan owner: tombol pada deployment
yang sedang building atau gagal, di menu baris untuk deployment yang ready) membuka log build terbaru di drawer samping,
dibaca dari Vercel saat Anda membukanya (2.000 baris terakhir, tidak disimpan), dengan baris error disorot dan link
"Jump to first error". Pada build yang gagal, owner juga mendapat **Explain with AI**: bagian akhir log (paling banyak
120 baris, baris error didahulukan, rahasia dibuang) dikirim ke AI provider yang terhubung di AI Gateway, dan jawabannya
menyebut apa yang rusak, kemungkinan perbaikannya, dan file-nya. Ini dihitung ke kuota AI (20 panggilan per 10 menit),
hanya berjalan saat tombolnya ditekan, dan tidak disimpan; menekannya lagi selagi jawabannya belum datang ditolak, jadi
satu build tidak dihitung dua kali. **What changed** (operator dan owner, di menu baris
deployment production yang ready dan dibangun dari sebuah commit) menampilkan commit di antara deployment itu dan
deployment production sebelumnya, dibaca dari GitHub saat Anda membukanya (50 terbaru, dengan nomor pull request yang
ditautkan kalau judul commit menyebutnya). Fitur ini butuh repository aplikasi yang sudah ditautkan dan GitHub yang
terhubung.

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

Menu Database dikelompokkan ke **Providers** (Supabase, Neon, Firebase, Turso, Upstash Redis, Cloudflare D1) dan
**Tools** (SQL console, Free databases).

**Supabase.** Status, region, dan versi Postgres tiap project dari Management API, yang tidak menyentuh database Anda.
Ukuran database dibaca sekali sehari, dan hanya selama project-nya memang sedang aktif. Per project (khusus owner):
**Keep active** memberi peringatan mulai hari ke-5 tanpa trafik API dan mengirim satu query keep-alive per hari agar
project gratis tidak di-pause; **Auto-restore** menghidupkan kembali project yang di-pause saat akunnya punya slot
gratis. **Check services** di menu baris langsung membaca kesehatan layanan project (Auth, REST, Realtime, Storage,
Database) dari Management API.

**Compute** di bawah tabel, per project yang punya metrics key (Secret API key yang ditambahkan owner): CPU, RAM, disk,
dan koneksi saat ini beserta 24 rata-rata per jam, lalu **Memory** (used, cache + buffers, dan swap dari total RAM, per
jam) dan **Memory commitment** (memori yang dijanjikan ke proses, dari batas sebelum kernel menolak; Warning mulai
85 %, Critical hanya kalau swap sudah setengah RAM atau RAM terpakai 95 %, beserta saran yang membantu), seperti di Observability › Database Supabase. Dibaca dari Metrics API Supabase setiap kali collector jalan: tiap
30 menit di konsol cloud, tiap 5 menit di self-host.

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

Di bawah sub-judul **Code**:

**Repositories.** Browser read-only untuk repository yang bisa dibaca token GitHub Anda: README, file, commit, branch,
run Actions, dan dependency advisory. Menampilkan "GitHub isn't connected" sampai Anda menambahkan token GitHub.

Di bawah sub-judul **Servers** (hanya self-hosted):

**Containers.** Container Docker di mesin tempat Watchbell berjalan, untuk operator dan owner. Mati sampai Anda
menyalakannya: lihat [Containers](containers.md).

Di bawah sub-judul **Security** (hanya self-hosted):

**OS vulnerabilities.** Kerentanan yang diketahui di mesin tempat Watchbell berjalan (Ubuntu untuk sekarang): kernel
dan reboot yang tertunda, update keamanan yang menunggu beserta skor CVSS tiap CVE, prioritas Ubuntu dan tautannya,
serta perintah untuk di-copy. Alert **OsSecurityUpdate** menyala selama salah satunya memperbaiki CVE dengan skor 7.0
ke atas. Lihat [OS vulnerabilities](os-vulnerabilities.md).

## Manage

Di menu, Manage dibagi jadi tiga judul: **Alerting** (Alerts, Auto-actions, Status page, Reports), **Setup** (Connections,
Settings, Sections, Backups), dan **AI & API** (AI Gateway, API explorer).

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

- Collector: seberapa sering tiap task collector berjalan, catatan keep-alive database, dan **Watchbell runtime**:
  Node.js tempat Watchbell ini berjalan (runtime function Vercel di edisi cloud, Node.js mesin itu kalau self-host).
  Setiap 12 jam Watchbell membaca daftar rilis di nodejs.org dan tanggal end-of-life Node.js di endoflife.date. Versi
  yang di line-nya sudah ada rilis security yang lebih baru tertulis, misalnya, "Node 24.12.0: security fix available
  (24.22.1)" dengan tanda peringatan; line yang sudah lewat end-of-life tertulis "end of life"; selain itu "ok".
  - Statusnya unknown, tidak pernah ok, kalau nodejs.org belum berhasil dibaca dalam 36 jam terakhir, atau
    endoflife.date belum pernah terbaca. Perbaikan atau end-of-life yang sudah diketahui tetap tampil.
  - Kalau `WATCHBELL_NO_UPDATE_CHECK=1` diset untuk server, tidak ada yang dibaca dan tertulis "check turned off".
  - Di self-host dengan paket npm, `watchbell start` dan `watchbell status` juga mencetak peringatan satu baris kalau
    Node.js-nya rentan atau sudah lewat end-of-life. `watchbell status` juga memeriksa Node.js yang dijalankan service
    yang terpasang. Peringatan itu tidak dicetak kalau ada `WATCHBELL_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, atau
    `CI`, dan service (`watchbell run`) tidak pernah mencetaknya.
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
- Branding (khusus owner, 1.7): nama aplikasi Anda, logo PNG persegi (maksimal 512 px dan 256 KB), warna aksen (dicek
  tetap terbaca di mode terang dan gelap), nama pengirim email (alamatnya tetap dari channel email Anda), dan alamat
  publik untuk tautan. Semuanya muncul di halaman login, sidebar, tab browser, laporan bulanan, email, dan status page
  publik, dengan tulisan kecil "Powered by Watchbell" yang bisa dimatikan. Command line, tautan docs, dan label versi
  tetap Watchbell.
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

**Reports** (1.7, semua member). Laporan PDF dua halaman tiap bulan per klien, dalam bahasa Indonesia atau Inggris.
Halaman 1 berisi kalender sebulan (tiap hari normal, lambat atau gangguan singkat, atau tidak bisa dibuka), tiap hari
bermasalah per website dalam kata-kata biasa, zona waktunya, serta uptime, response, dan update; halaman 2 berisi response per hari, update,
peringatan, catatan Anda, dan arti angka-angkanya. Website di laporan memakai nama yang Anda ketik, tidak pernah alamat,
teks error, atau nama provider. Unduh bulan mana pun yang datanya masih disimpan (Settings › Retention), dalam kedua
bahasa. Owner bisa mengirimnya otomatis tiap tanggal 1 dengan PDF terlampir, ke maksimal 5 alamat, lewat channel Email
(SMTP) atau Resend; pengiriman yang gagal dicoba lagi tanggal 2 dan 3, lalu alert ReportSendFailed memberi tahu Anda;
untuk bulan itu owner bisa **Send again** atau menandai **I sent it myself**. Operator mengubah isi laporan dan mengirim tes ke dirinya sendiri; viewer mengunduh.

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
