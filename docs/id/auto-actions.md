# Auto-actions

English: [../auto-actions.md](../auto-actions.md)

Saat sebuah alert firing, Watchbell bisa mengusulkan perbaikan: salah satu aksi yang memang sudah ada di console,
misalnya mengecek ulang sebuah situs atau me-roll back deploy yang bermasalah. Anda menyetujui atau menolaknya di
halaman **Auto-actions** atau dengan tombol di pesan Telegram-nya. Aksi yang disetujui berjalan lewat kode,
pengecekan, dan audit trail yang sama seperti saat Anda menekan tombolnya sendiri, dengan Anda sebagai pelakunya.

- [Alert mana mengusulkan apa](#alert-mana-mengusulkan-apa)
- [Menyetujui dan menolak](#menyetujui-dan-menolak)
- [Auto-run yang aman](#auto-run-yang-aman)
- [Auto-rollback setelah deploy yang bermasalah](#auto-rollback-setelah-deploy-yang-bermasalah)
- [Perbaikan keamanan otomatis](#perbaikan-keamanan-otomatis)
- [Tempat melihat apa yang terjadi](#tempat-melihat-apa-yang-terjadi)

## Alert mana mengusulkan apa

| Alert | Aksi yang diusulkan | Risiko |
|---|---|---|
| MonitorDown, HighLatency (pengecekan HTTP sebuah aplikasi) | Check again now | aman |
| MonitorDown, HighLatency, saat compute Neon aplikasi itu sedang suspended | Wake Neon | aman |
| MonitorDown pada heartbeat job harian milik Watchbell sendiri | Rerun daily job | berisiko |
| MonitorDown pada pengecekan HTTP sebuah aplikasi, di luar window auto-rollback | Redeploy production, Roll back to previous deployment | berisiko |
| MonitorDomainMoved (domain pengecekan sudah bukan domain aplikasi itu) | Update monitor (domain baru aplikasi, path yang sama); tidak pernah redeploy atau roll back | aman |
| MonitorDown atau HighLatency di menit-menit pertama setelah deploy production baru | Roll back to previous deployment | berisiko (lihat auto-rollback) |
| DeploymentFailed | Redeploy production, Roll back to previous deployment | berisiko |
| AutoPauseRisk (Supabase) | Send Supabase keep-alive | aman |
| DatabasePaused (Supabase) | Restore Supabase project | berisiko |
| CertExpiringSoon | Re-check domain certificate | aman |
| VulnerableDependency | Open package update PR | berisiko |
| FrameworkVulnerable (kartu Security aplikasi: versi Next.js-nya punya advisory yang diketahui) | Open package update PR untuk `next` (dan `eslint-config-next` kalau tercantum) | berisiko |
| LogErrorSpike (dari log, tanpa alert): deployment production live kurang dari 2 jam lalu dan sudah mencatat paling sedikit 10 error, dan paling sedikit 5 kali laju per jam dalam 24 jam sebelumnya | Roll back to previous deployment | berisiko |
| LogErrors (dari log, tanpa alert): 20 error atau lebih dalam 30 menit terakhir, tanpa deploy production dalam 2 jam terakhir | Check again now (pengecekan HTTP aplikasi itu) | aman |
| LogDbErrors (dari log, tanpa alert): 3 error koneksi database atau lebih dalam 30 menit terakhir, untuk aplikasi yang punya database tertaut | Wake Neon (compute Neon yang suspended), Restore Supabase project (project Supabase yang di-pause) | aman, berisiko |

Usulan dibuat paling banyak sekali per alert dan aksi. Tiga aturan log membaca baris error yang disimpan Watchbell dari
log Vercel (Hosting); aturan ini tidak punya alert, jadi usulannya kedaluwarsa saat log tidak lagi menunjukkan masalahnya,
dan usulan yang sudah ditutup tidak diusulkan lagi selama 2 jam. Usulan yang masih pending kedaluwarsa setelah 2 jam, atau lebih
cepat kalau alert-nya resolved. Alert yang di-silence tidak mengusulkan apa pun. Usulan disimpan selama 30 hari.

**Perbaikan Next.js.** Kartu Security di halaman aplikasi membaca versi Next.js yang dijalankan situs live dan
mencarinya di OSV.dev setiap 6 jam, tepat setelah setiap deployment production baru, dan di job harian. Kalau ada
advisory, alert FrameworkVulnerable menyala (critical kalau salah satu advisory-nya critical) dan, untuk aplikasi yang
repository GitHub-nya sudah ditautkan, Watchbell mengusulkan pull request update yang menaikkan `next` ke versi terkecil
yang memperbaiki advisory-nya di major version yang sama (misalnya 16.3.8 ke 16.4.1), dan `eslint-config-next` ke versi
yang sama kalau `package.json` mencantumkannya. Update major hanya diusulkan kalau tidak ada perbaikan di major yang
sekarang; alert menyebut versi yang sama dengan usulannya, dan memberi tahu kalau sebagian advisory baru diperbaiki di
major berikutnya. Anda hanya ditanya sekali untuk `next`: kalau scan dependency aplikasi yang sama sudah mengusulkan
update untuknya, usulan Next.js tidak dibuat, dan kalau usulan Next.js (atau pull request Watchbell yang masih terbuka
untuk `next`) lebih dulu ada, usulan scan dependency tidak menyertakan `next`. Setiap pull request update yang menaikkan
`next` ikut menaikkan `eslint-config-next`, dicantumkan sebagai "updated to match". Tanpa repository yang ditautkan,
langkah berikutnya di alert meminta Anda menautkannya di halaman aplikasi (atau meng-update `next` sendiri). Pull
request update butuh GitHub, jadi tidak diusulkan selama section DevOps mati.

**Monorepo.** Kalau project Vercel punya Root Directory (misalnya `apps/web`), scan dependency membaca
`apps/web/package.json` dan lockfile di sana, dan pull request update mengubah `package.json` itu, menyebut folder-nya di
judul, dan meminta Anda menjalankan `npm install` di folder itu. Dua aplikasi dalam satu repository (misalnya `apps/web`
dan `apps/admin`) masing-masing mendapat pull request sendiri. Kalau folder itu tidak punya lockfile, lockfile di root
repository hanya dipakai kalau root-nya workspace yang mencakup folder itu (lockfile-nya mencantumkan folder itu, atau
`workspaces` di `package.json` root cocok dengannya); kalau tidak, versinya diambil dari range di `package.json` folder
itu dan kartunya menyebutkan hal itu. Kartu Dependencies menampilkan file yang di-scan, misalnya
`apps/web/package-lock.json`. Root Directory yang tidak bisa dipakai Watchbell (karakter tidak biasa seperti spasi atau
`@`, atau lebih dari 4 folder dalam) disebut di kartu, root yang di-scan sebagai gantinya, dan tidak ada pull request
update yang dibuka untuk aplikasi itu. Watchbell membaca Root Directory dari Vercel setiap sync harian, atau saat Anda
menekan Sync di Connections. Kalau beberapa aplikasi berbagi satu repository, scan harian memakai folder aplikasi yang
dipantau; Scan now di halaman aplikasi men-scan folder aplikasi itu.

Aksi **aman** hanya membaca atau memberi dorongan kecil (cek ulang, membangunkan, query keep-alive). Aksi **berisiko**
mengubah production (redeploy, roll back, restore, membuka pull request, menjalankan ulang job harian). Aksi berisiko
selalu menunggu Anda, kecuali aturan auto-rollback yang sempit di bawah, yang harus Anda aktifkan sendiri.

## Menyetujui dan menolak

- **Di halaman Auto-actions** (khusus owner): "Waiting for you" menampilkan usulan yang pending beserta alasan dan
  targetnya. Approve langsung menjalankan aksinya; Reject menutupnya. Di bawahnya ada riwayat semua yang diusulkan,
  dijalankan, ditolak, atau kedaluwarsa.
- **Di Telegram**, dengan [tombol approval](notifications.md#tombol-approval) aktif: setiap pesan usulan punya tombol
  **Approve** dan **Reject**. Hanya akun Telegram yang sudah Anda tautkan yang bisa memakainya. Untuk aksi berisiko,
  Approve lebih dulu berubah menjadi **Sure? Approve**, yang harus Anda tekan dalam 2 menit. Di laptop yang
  self-hosted, tombol bekerja selama Watchbell berjalan (lihat
  [Cara tombol sampai ke laptop](notifications.md#cara-tombol-sampai-ke-laptop)).

Aksi-aksi ini butuh izin token yang sesuai, misalnya token Supabase dengan Project admin: Write untuk me-restore sebuah
project (lihat [Menghubungkan provider](providers.md)).

## Auto-run yang aman

**Settings › Auto-actions** menampilkan setiap jenis aksi. Jenis yang aman punya sakelar: kalau sakelarnya aktif,
usulan jenis itu dijalankan tanpa bertanya dan Anda menerima satu baris singkat di Telegram sesudahnya. Semua sakelar
**mati** secara default. Jenis yang berisiko tidak punya sakelar dan selalu menunggu Anda.

## Auto-rollback setelah deploy yang bermasalah

Mati secara default; aktifkan di Settings › Auto-actions. Kalau aktif, deploy production baru di Vercel yang merusak
aplikasi akan di-roll back ke deployment sebelumnya tanpa bertanya, tetapi hanya:

- dengan aksi roll back, tidak ada yang lain;
- dalam N menit pertama setelah deploy baru itu live (Anda memilih N antara 10 dan 120; default 30);
- kalau monitor aplikasi itu down atau log menunjukkan lonjakan error;
- sekali per deployment, dan tidak pernah dua kali untuk satu aplikasi dalam 2 jam.

Setiap rollback dilaporkan di Telegram dan di Events. Build yang gagal tidak pernah live di Vercel, jadi fitur ini
untuk build yang berhasil tetapi rusak saat runtime. Di luar window itu, situs yang terus down mendapat usulan redeploy
dan rollback yang menunggu approval Anda.

## Perbaikan keamanan otomatis

Saat scan dependency sebuah aplikasi yang dipantau (atau pengecekan Next.js di kartu Security-nya) menemukan advisory
critical, high, atau moderate yang sudah punya versi perbaikan, Watchbell bisa memperbaikinya dari awal sampai akhir.
Fitur ini butuh [token GitHub PR-write](providers.md#github-pr-write) di Connections. Lalu Watchbell:

1. membuka pull request update sendiri (hanya `package.json`, di branch baru `watchpost/deps-…`), hanya untuk
   dependency langsung yang perbaikannya masih di versi mayor yang sama, dan tidak pernah dua kali untuk package yang
   sama selama pull request-nya masih terbuka;
2. menunggu check GitHub (semuanya hijau), lalu menunggu preview Vercel untuk pull request itu;
3. menguji preview-nya: `/` dan sampai 3 path monitor harus menjawab 200 sampai 399 dalam 15 detik (untuk preview di
   belakang Vercel Authentication: 3 menit tanpa baris error di log-nya);
4. melakukan squash-merge, tetapi hanya selama auto-rollback aktif, supaya auto-rollback menjaga menit-menit pertama
   deploy production yang menyusul.

Sebelum merge, Watchbell memeriksa isi pull request-nya: hanya `package.json` yang dinaikkan (di folder app) dan
lockfile-nya yang boleh berubah, lockfile itu wajib ada kalau scan menemukannya, dan di `package.json` hanya nomor versi
paket yang diperbarui yang boleh berbeda dari base branch (tanpa script, overrides, dependency lain, atau sumber
`github:`). Di `package-lock.json`, setiap paket yang baru atau berubah harus berupa tarball dari registry yang sudah
dipakai lockfile di base branch (secara default registry npm), dalam bentuk registry itu sendiri
`/<nama>/-/<nama>-<versi>.tgz`, dengan integrity `sha512-`; link dan sumber `git+`, `file:`, `github:` atau `http:`
ditolak, begitu juga `lockfileVersion` yang berubah atau selain 2 dan 3, dan lockfile yang lebih dari 25 MB. Setiap
commit juga harus berasal dari akun milik token PR-write itu sendiri atau berupa commit lockfile dari workflow GitHub
Actions (yang hanya boleh mengubah lockfile). Selain itu, pull request-nya berhenti dengan "needs a look: unexpected
change in …" (atau "unexpected lockfile change …") dan tetap terbuka untuk Anda. Orang yang bisa push ke branch itu
tetap bisa menulis commit atas nama lain, jadi pemeriksaan isi inilah pengamannya. Yang belum diperiksa adalah apakah
integrity dan dependency sebuah paket registry sama dengan yang diterbitkan registry untuk versi itu; sampai pemeriksaan
itu ada, lockfile palsu masih bisa menambahkan paket registry yang benar-benar ada sebagai dependency baru, atau
memindahkan paket mana pun yang sudah ada di lockfile ke versi registry lain yang benar-benar ada (misalnya rilis lama
yang rentan). Keduanya ditutup di 1.2.2 dengan pemeriksaan registry itu. Jenis lockfile lain (`pnpm-lock.yaml`,
`yarn.lock`, `bun.lock`) tidak bisa diperiksa, jadi pull request-nya selalu menunggu Anda.

Kalau ada yang gagal, atau belum selesai dalam 45 menit, pull request-nya tetap terbuka dengan tanda "needs a look".
Update mayor, package transitif, atau severity yang Anda matikan menjadi usulan biasa yang menunggu approval Anda.
Setiap pull request yang dibuka dan setiap merge atau penghentian dikirim ke Telegram dan dicatat di Events.

Perbaikan keamanan otomatis tercantum aktif secara default di Settings › Auto-actions, tetapi tidak ada yang terjadi
sampai token GitHub PR-write terhubung, dan tidak ada yang di-merge kecuali auto-rollback juga aktif. Pilih severity-nya
(Critical, High, dan Moderate, semuanya aktif secara default; pengaturan yang disimpan sebelum 1.2.1 punya Moderate
aktif kalau High aktif) atau matikan fitur ini di sana.

**Moderate diperlakukan seperti High.** Advisory moderate pada dependency langsung yang sampai ke production (bukan yang
di `devDependencies`) memunculkan alert VulnerableDependency dengan tingkat warning, sama seperti high, dan perbaikannya
dibuka sendiri selama switch Moderate aktif. Perbaikan moderate untuk package di `devDependencies` menunggu approval
Anda. Banyak advisory di satu repository tetap menghasilkan satu pull request. Advisory low dan unknown hanya
ditampilkan di halaman aplikasi.

**Kapan dicek.** Task security di collector dimulai setiap 6 jam (tercantum di Settings › Collector): task ini men-scan
repository yang ditautkan ke aplikasi yang dipantau, mulai dari yang paling lama, dan lockfile yang tidak berubah hanya
memakan satu pembacaan GitHub tanpa pencarian advisory baru, lalu membaca versi Next.js setiap aplikasi yang dipantau.
Kalau itu tidak muat dalam satu run collector, task ini dilanjutkan di run menit-menit berikutnya sampai setiap
repository sudah di-scan dan setiap aplikasi sudah dicek sekali; situs yang pengecekannya kehabisan waktu dicoba lagi di
run berikutnya, dan setelah dua kali mencoba menunggu job harian. Saat Watchbell melihat deployment production baru dari
aplikasi yang dipantau, aplikasi itu dicek di run menit berikutnya tanpa menunggu 6 jam, sekali per deployment
(pengecekan yang terus kehabisan waktu dicoba paling banyak tiga kali). Job harian tetap mengecek semuanya juga. Selama
DevOps mati, tidak ada yang dibaca dari GitHub; selama Hosting mati, pengecekan Next.js berhenti sementara.

**Branch yang dipakai.** Scan dependency membaca branch yang di-deploy Vercel ke production (production branch
project-nya) kalau repository punya branch itu, kalau tidak branch default repository, jadi advisory-nya adalah milik
versi yang sedang live. Pull request update menuju branch yang sama dan di-merge ke sana, jadi perbaikan tetap sampai ke
production walaupun branch default bukan branch yang sedang live. Kalau base pull request-nya diubah di GitHub (misalnya
saat branch itu dihapus), Watchbell berhenti dan menandainya "needs a look" alih-alih melakukan merge.

**package-lock.json.** Pull request update butuh `package-lock.json` yang cocok. Watchbell tidak menjalankan `npm`
sendiri untuk project Anda; Settings › Lockfile menjelaskan cara menyiapkan repository GitHub kecil milik Anda sendiri
dengan workflow GitHub Actions yang mengerjakannya. Setelah membuka pull request update, Watchbell meminta workflow itu
menjalankan `npm install --package-lock-only --ignore-scripts` di branch pull request tersebut lalu push lockfile yang
baru (gratis, berjalan di GitHub, install script dimatikan). Workflow ini memakai token PR-write yang sama, yang
disimpan di sana sebagai repository secret `WATCHBELL_PR_TOKEN`.

## Tempat melihat apa yang terjadi

- **Events** berisi setiap approval, penolakan, auto-run, dan hasilnya, beserta siapa yang melakukannya.
- **Auto-actions** menampilkan status setiap usulan dan hasilnya dalam satu baris.
- **Telegram** menerima usulannya, dan satu baris setelah setiap auto-run, rollback, atau merge.
