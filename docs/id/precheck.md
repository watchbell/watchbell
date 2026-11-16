# Pre-deploy check

English: [../precheck.md](../precheck.md)

Pre-deploy check adalah workflow GitHub Actions yang Anda tambahkan ke repository aplikasi. Di setiap pull request,
pengecekan ini melihat apa yang ditambahkan pull request itu lalu menulis hasilnya sebagai satu komentar, yang diedit
setiap ada push baru:

- **Packages**: versi paket yang ditambahkan atau diubah pull request itu di lockfile, dicek ke OSV.dev. Yang
  dicantumkan hanya advisory untuk versi-versi itu; apa yang sudah terpasang di branch default adalah tugas kartu
  Dependencies.
- **Secrets**: kemungkinan key, token, dan password di commit pull request itu, ditemukan oleh gitleaks. Komentarnya
  menyebut file, baris, rule, dan commit, tidak pernah nilainya.
- **Next.js**: versi yang dipasang pull request itu, dan versi yang digantikannya.
- **Env names**: nama yang ditambahkan ke `.env.example`, dan nama `process.env` yang baru dibaca di kode tapi tidak ada
  di `.env.example`, supaya Anda bisa mengesetnya di Vercel sebelum merge.

Pengecekan ini **hanya peringatan**: job-nya selalu lolos dan tidak pernah menghalangi merge. Baris pertama komentar
menyebut apakah ada yang perlu diperbaiki sebelum merge, ada yang perlu dicek, atau tidak ada masalah baru. Kartu Pull
requests di console (lihat [Halaman › Hosting](pages.md#hosting)) membaca komentar-komentar ini.

## Menambahkannya ke repository

Tambahkan `.github/workflows/watchbell-check.yml` ke repository aplikasi:

```yaml
name: Watchbell pre-deploy check
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  precheck:
    uses: watchbell/watchbell/.github/workflows/precheck.yml@v1.8.1
    with:
      working-directory: .
```

Isi `working-directory` dengan folder yang berisi `package.json` dan lockfile aplikasi kalau aplikasinya tidak ada di
root repository, misalnya `apps/web`. Pengecekan berjalan di pull request berikutnya.

Lockfile yang didukung: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, dan `bun.lock`.

## Apa yang dikirim ke mana

- Nama dan versi paket yang ditambahkan pull request dikirim ke OSV.dev (gratis, tanpa key).
- Komentarnya dikirim ke pull request Anda dengan token milik workflow itu sendiri. Tidak ada yang dikirim ke
  Watchbell, dan workflow-nya tidak pernah mendapat token Vercel atau token provider lain.
- gitleaks berjalan di runner dan dicek dulu terhadap checksum resminya sebelum dijalankan. gitleaks mengikuti
  `.gitleaks.toml` dan `.gitleaksignore` milik repository itu, termasuk yang ditambahkan sebuah pull request, jadi
  periksa perubahan di file-file itu seperti kode lainnya.
- Push baru ke pull request yang sama membatalkan run yang lebih lama, jadi komentarnya selalu menggambarkan commit
  terakhir.

## Pull request dari fork

GitHub memberi pull request dari fork token yang hanya bisa membaca, jadi pengecekan ini tidak bisa berkomentar di
sana. Hasilnya tetap ada di job summary run itu dan sebagai warning di run tersebut.

## Kalau satu bagian tidak dicek

Tiap bagian berjalan sendiri-sendiri. Kalau satu bagian tidak bisa berjalan (tidak ada lockfile di folder itu, OSV.dev
tidak menjawab, gitleaks gagal diunduh), komentarnya menulis "Not checked" beserta alasannya dan bagian lain tetap
melapor. Bagian yang tidak dicek tidak pernah terbaca sebagai "tidak ada masalah".
