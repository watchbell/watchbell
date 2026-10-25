# Menghubungkan provider

English: [../providers.md](../providers.md)

Watchbell membaca provider Anda dengan token yang Anda buat di dashboard masing-masing provider. Semuanya opsional:
hubungkan hanya yang Anda pakai.

- [Cara kerja koneksi](#cara-kerja-koneksi)
- [Vercel](#vercel)
- [Supabase](#supabase)
- [Neon](#neon)
- [Firebase](#firebase)
- [Turso](#turso)
- [Upstash](#upstash)
- [Cloudflare](#cloudflare)
- [GitHub (read-only)](#github-read-only)
- [GitHub (PR write)](#github-pr-write)
- [Kalau token kekurangan izin](#kalau-token-kekurangan-izin)

## Cara kerja koneksi

1. Di Watchbell, buka **Connections** (khusus owner). Provider ditampilkan sebagai tile yang dikelompokkan menurut
   bagiannya (Hosting, Database, DevOps; backup Google Drive ada di bawah Manage). Setiap tile menunjukkan apakah
   provider-nya sudah terhubung, berapa akunnya, dan apakah ada akun yang perlu diperhatikan. Klik sebuah tile untuk
   membuka drawer-nya. Link ke `/connections?provider=<nama>` (misalnya `?provider=neon`) langsung membuka drawer itu.
2. Di drawer, **Create one** membuka halaman token provider (link ada di bawah), dan **It needs** menampilkan izin
   paling kecil yang dibutuhkan. Buat token-nya di sana.
3. Tempel token, beri nama untuk akunnya (ditampilkan di samping semua data yang berasal dari akun itu), lalu tekan
   **Test connection** untuk mengeceknya tanpa menyimpan apa pun. **Save** selalu menjalankan tes yang sama lebih dulu
   dan baru menyimpan token kalau tesnya berhasil. Token dengan akses lebih luas dari yang dibutuhkan Watchbell tetap
   diterima. Watchbell baru bisa tahu setelah sebuah aksi memakai akses tulis token itu; sejak saat itu baris
   **Access** di akun tersebut menampilkan "Actions on".
4. Tekan **Sync** pada akun yang baru. Sync menampilkan semua yang bisa dilihat token; centang apa saja yang harus
   dipantau Watchbell lalu simpan pilihan itu. Tidak ada yang dipantau sampai Anda memilih.

Setiap akun di drawer juga punya **Test connection** (mengecek ulang token yang tersimpan dan memperbarui status akun:
token yang ditolak menandai akun itu perlu diperhatikan), **Replace credential**, dan **Remove**. Provider yang hanya
mengizinkan satu akun (Vercel, GitHub, dan token GitHub PR-write) tidak menawarkan akun kedua setelah terhubung.

Token dienkripsi dengan `OPS_ENCRYPTION_KEY` (AES-256-GCM) sebelum disimpan, tidak pernah dikirim ke browser Anda, dan
tidak pernah ditampilkan lagi. Untuk menggantinya, pakai **Replace credential**: token lama dihapus begitu token baru
berhasil dipakai. Menghapus sebuah akun menghapus token-nya dari Watchbell dan menghentikan pemantauan resource-nya;
tidak ada yang berubah di provider. Watchbell memberi peringatan 14 hari sebelum token yang punya tanggal kedaluwarsa
habis masa berlakunya (alert bernama CredentialExpiring).

Pakai izin paling kecil yang sudah mencakup kebutuhan Anda. Setiap bagian di bawah menyebutkan izin read-only lebih
dulu, lalu izin tambahan yang hanya dibutuhkan beberapa aksi. Untuk provider yang tidak punya token read-only, aksi
selalu meminta konfirmasi Anda.

## Vercel

- Buat di: https://vercel.com/account/settings/tokens (sebuah **Access token**).
- Scope: akun Anda (atau team yang memiliki project Anda).
- Set tanggal kedaluwarsa; Watchbell mengingatkan Anda sebelum habis.
- Satu akun Vercel per Watchbell.

Token Vercel tidak bisa dibuat read-only. Watchbell memakai token ini untuk menampilkan project, deployment, domain,
request log, dan analytics, dan hanya saat Anda (atau auto-action yang sudah disetujui) memintanya, untuk redeploy,
roll back, atau promote.

## Supabase

- Buat di: https://supabase.com/dashboard/account/tokens. Pakai **scoped access token**, bukan yang full-access.
- Boleh beberapa akun Supabase (masing-masing punya dua project aktif gratis).

Izin read-only untuk pemantauan:

| Izin | Kegunaannya |
|---|---|
| Projects: Read | Status, region, versi Postgres |
| Project admin: Read | Kesehatan service |
| Analytics usage: Read | Trafik API terakhir dan risiko auto-pause |
| Organization admin: Read | Paket gratis, untuk menghitung slot gratis |
| Database: Read | Ukuran database, sekali sehari (diperiksa saat pembacaan harian pertama, karena mengujinya berarti menjalankan query ke database Anda) |

Tambahkan izin berikut hanya untuk fitur yang membutuhkannya:

| Izin | Dibutuhkan untuk |
|---|---|
| Project admin: Write | Pause dan restore project, Auto-restore |
| Database: Read-write dan Connection pooling: Read | Menyiapkan role SQL read-only secara otomatis (lihat [SQL console](sql-console.md)) |
| Organization: Projects: Create (`organization_projects_create`) | Membuat project baru dari create request (khusus organisasi dengan paket gratis) |

## Neon

- Buat di: https://console.neon.tech/app/settings/api-keys (**API key** personal, organisasi, atau project).
- Boleh beberapa akun Neon.

Neon tidak punya key read-only, jadi key-nya tetap di server dan setiap aksi meminta konfirmasi. Watchbell membaca
status compute, CU-hour, storage, dan transfer; membacanya tidak pernah membangunkan compute. Membangunkan compute dan
membuat branch memakai key yang sama.

## Firebase

- Buat di: https://console.cloud.google.com/iam-admin/serviceaccounts. Buat **service account** lalu unduh key-nya
  dalam format JSON, kemudian tempel seluruh isi file JSON itu ke Watchbell.
- Beri role berikut di setiap project yang ingin dipantau, dan tidak lebih:
  `firebase.viewer`, `datastore.viewer`, `monitoring.viewer`, `firebaseauth.viewer`.
- Aktifkan **Cloud Monitoring API** di setiap project, supaya Watchbell bisa membaca jumlah read, write, dan delete hari
  ini.
- Satu service account per akun Google.

Service account yang sama menjalankan query builder Firestore di [SQL console](sql-console.md) (butuh
`datastore.viewer`).

**Membuat project Firebase** (opsional) memakai sign-in Google terpisah dengan scope `cloud-platform`, karena role
viewer tidak bisa membuat project. Fitur ini butuh Google OAuth client yang sama dengan [Backup](backups.md): set
`GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET`, lalu tambahkan `<SITE_URL>/auth/google/create/callback` sebagai
authorized redirect URI kedua. Setelah itu pakai **Connect Google (create projects)** di halaman Firebase.

## Turso

- Buat di: https://app.turso.tech/account/api-tokens, atau dengan Turso CLI:

  ```bash
  turso auth api-tokens mint watchbell --org <your-org>
  ```

- Pakai **platform API token** yang dibatasi ke satu organisasi. Token database atau token group tidak akan bisa:
  token seperti itu tidak bisa menampilkan daftar apa pun.
- Boleh beberapa akun Turso.

Turso tidak punya platform token read-only. Watchbell hanya menampilkan daftar database dan membaca row read, row
written, dan storage bulan ini dibandingkan dengan paket gratis.

## Upstash

- Buat di: https://console.upstash.com/account/api. Buat **Developer API key** lalu pilih **Read Only**
  (Account, Management API).
- Tempel dengan format `your-email:API_KEY` (email login Upstash Anda, titik dua, lalu key-nya). Upstash
  menandatangani panggilan API dengan keduanya.
- Boleh beberapa akun Upstash.
- Hanya database yang dibuat di akun Upstash yang bisa dibaca. Database Redis yang dibuat lewat integrasi Vercel tidak
  bisa dibaca dengan cara ini.

## Cloudflare

- Buat di: https://dash.cloudflare.com/profile/api-tokens (**Create Token**, lalu custom token).
- Boleh beberapa akun Cloudflare.

Izin read-only untuk pemantauan:

| Izin | Kegunaannya |
|---|---|
| Zone: Zone: Read | Zone Anda |
| Zone: DNS: Read | Record DNS |
| Zone: SSL and Certificates: Read | Sertifikat |
| Zone: Zone Settings: Read (opsional) | Mode SSL/TLS tiap zone |
| Account: D1: Read (opsional) | Memantau database Cloudflare D1 (ukuran dan tabel) |
| Account: Account Analytics: Read (opsional) | Row read dan row written D1 |

Tambahkan hanya kalau Anda membutuhkannya:

| Izin | Dibutuhkan untuk |
|---|---|
| Zone: DNS: Edit | Mengedit dan menambah record dari halaman DNS records, dan "Set DNS only" di Domains. Record tidak pernah dihapus. |

Tidak dibutuhkan: Registrar. Tanggal kedaluwarsa domain diambil dari RDAP, yang bersifat publik.

## GitHub (read-only)

- Buat di: https://github.com/settings/personal-access-tokens/new (**fine-grained token**, diawali dengan
  `github_pat_`). Token classic tidak bisa dibatasi menjadi read-only.
- Repository access: semua repository, atau hanya yang menjadi sumber deploy aplikasi Anda.
- Repository permissions, masing-masing **Read-only**: Metadata, Contents, Actions. Tidak ada yang lain.
- Set tanggal kedaluwarsa.

Sync menampilkan repository Anda, aplikasi dihubungkan ke repository-nya masing-masing, dan halaman aplikasi
menampilkan status GitHub Actions dan dependency advisory-nya. Halaman Repositories menjelajahi repository tersebut.

## GitHub (PR write)

Opsional, dan merupakan fine-grained token yang **terpisah** dari token read-only. Watchbell memakainya hanya untuk
membuka pull request yang meng-update package yang rentan (saat Anda menyetujuinya, atau secara mandiri dengan
perbaikan keamanan otomatis) dan untuk me-merge pull request update buatannya sendiri kalau Anda mengizinkan.
Watchbell tidak pernah push langsung ke default branch Anda.

- Buat di: https://github.com/settings/personal-access-tokens/new.
- Repository access: **Only select repositories**, yaitu repository yang ingin Anda beri pull request update.
- Repository permissions: Contents: Read and write, Pull requests: Read and write, Commit statuses: Read (untuk merge
  otomatis). Tidak ada yang lain (GitHub menambahkan Metadata: Read sendiri).
- Set tanggal kedaluwarsa.

Lihat [Auto-actions](auto-actions.md#perbaikan-keamanan-otomatis).

## Kalau token kekurangan izin

- **Test connection gagal** dengan pesan soal izin: token tidak bisa melakukan pembacaan dasar. Buat token baru dengan
  izin read di atas lalu pakai Replace credential.
- **Sebuah aksi gagal dengan "missing permission"** (misalnya `database_write` saat menyiapkan role SQL Supabase,
  atau "can't add DNS records" untuk Cloudflare): token bisa membaca tetapi tidak bisa melakukan aksi itu. Buat token
  dengan izin tambahan dari tabel di atas lalu pakai Replace credential, atau kerjakan langkah itu secara manual di
  provider.
- **Banner menyatakan sebuah connection perlu diperhatikan**: token sudah kedaluwarsa atau dicabut. Data dari akun itu
  tidak diperbarui sampai Anda menggantinya.

Lihat juga [Troubleshooting](troubleshooting.md#token-kekurangan-izin).
