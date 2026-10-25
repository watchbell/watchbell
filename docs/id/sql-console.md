# SQL console

English: [../sql-console.md](../sql-console.md)

**Database › SQL console** (khusus owner) menjalankan query read-only ke database Supabase dan Neon yang Anda pantau,
dan punya query builder untuk Firestore. Fitur ini untuk melihat, bukan mengubah: setiap query berjalan sebagai role
database read-only yang Anda buat untuk Watchbell, di dalam transaksi read-only yang di-rollback sesudahnya.

- [Memberi Watchbell akses read-only](#memberi-watchbell-akses-read-only)
- [Row level security](#row-level-security)
- [Menjalankan query](#menjalankan-query)
- [Postgres untuk pengguna MySQL](#postgres-untuk-pengguna-mysql)
- [Firestore](#firestore)
- [Mencabut akses](#mencabut-akses)

## Memberi Watchbell akses read-only

Buka tab **SQL access**. Setiap project Supabase dan project Neon yang dipantau punya satu baris; tekan
**Add SQL access** di salah satunya.

### Supabase: otomatis

**Set up automatically (read-only)** membuat role untuk Anda lewat Supabase Management API. Fitur ini butuh token
Supabase dengan **Database: Read-write** dan **Connection pooling: Read** (lihat
[Provider](providers.md#supabase)); kalau token-nya tidak punya izin itu, dialog-nya menyebut izin mana yang kurang
(misalnya `database_write`) dan Anda bisa mengganti token atau memakai langkah manual. Password yang dibuat tidak
pernah meninggalkan mesin Anda: yang dikirim ke Supabase hanya hash SCRAM-nya.

### Supabase dan Neon: manual

1. Jalankan ini sekali di SQL editor provider-nya (Supabase: SQL Editor, sebagai `postgres`; Neon: SQL Editor,
   sebagai `neondb_owner`, dan pakai `neondb` alih-alih `postgres` di baris `grant connect`). Ganti password-nya
   dengan password acak yang panjang.

   ```sql
   create role watchpost_ro login password 'REPLACE-with-a-long-random-password';
   alter role watchpost_ro set default_transaction_read_only = on;
   alter role watchpost_ro set statement_timeout = '5s';
   grant connect on database postgres to watchpost_ro;
   grant usage on schema public to watchpost_ro;
   grant select on all tables in schema public to watchpost_ro;
   alter default privileges for role postgres in schema public grant select on tables to watchpost_ro;
   -- Optional: lets "Active connections" and "Slow queries" see every role's activity.
   grant pg_read_all_stats to watchpost_ro;
   ```

   (Di Neon, baris `alter default privileges` menyebut `neondb_owner` alih-alih `postgres`. Dialog-nya menampilkan
   script yang persis untuk tiap provider beserta tombol Copy.)

2. Susun connection string dengan role yang baru:

   - **Supabase:** Connect › **Transaction pooler**, dengan user diganti menjadi `watchpost_ro.<project-ref>`:
     `postgresql://watchpost_ro.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`.
     Pakai string pooler; host langsung `db.<ref>.supabase.co` ditolak.
   - **Neon:** Connect, dengan role diganti menjadi `watchpost_ro`:
     `postgresql://watchpost_ro:<password>@ep-…-pooler.<region>.aws.neon.tech/neondb`.

3. Tempel di dialog lalu tekan **Test and save**. Saat menyimpan, Watchbell terhubung sekali dan memastikan role itu
   **tidak bisa menulis**; role yang bisa menulis ditolak. Role `postgres`, `supabase_admin`, dan `service_role`
   langsung ditolak. String-nya dienkripsi dan tidak pernah ditampilkan lagi.

Kalau password berisi `# @ [ ] / ? :`, lakukan URL-encode pada password di dalam string itu, atau pilih password yang
hanya berisi huruf dan angka.

Compute Neon yang sedang idle harus bangun dulu untuk menjalankan query (yang memakai CU-hour). Watchbell tidak pernah
membangunkannya sendiri: ia bertanya dulu "Running this will wake the Neon compute (uses CU-hours). Run anyway?".

## Row level security

Tabel Supabase biasanya mengaktifkan **row level security (RLS)**. Role `watchpost_ro` bukan pemilik tabel dan tidak
melewati RLS, jadi tabel dengan RLS aktif mengembalikan **nol baris** ke role ini, tanpa error, kecuali ada policy yang
mengizinkannya.

Agar Watchbell bisa membaca satu tabel, tambahkan policy khusus SELECT untuk role ini saja (role milik aplikasi Anda
sendiri tidak terpengaruh):

```sql
create policy watchpost_ro_read on public.<table> for select to watchpost_ro using (true);
```

Dialog-nya juga punya script opsional (tidak pernah dijalankan untuk Anda) yang menambahkan policy ini ke setiap tabel
public yang RLS-nya aktif. Periksa dulu: script itu membuat `watchpost_ro` bisa membaca setiap baris di tabel-tabel
tersebut.

## Menjalankan query

Di tab **Postgres**, pilih database berdasarkan alias-nya, tulis query, lalu jalankan.

- Hanya satu statement dalam satu waktu, dan hanya `SELECT`, `WITH`, `EXPLAIN` (tanpa `ANALYZE`), `SHOW`, dan
  `TABLE`. Parameter seperti `$1` tidak didukung; tulis nilainya langsung di query. Unicode escape (`U&'…'` dan
  `U&"…"`) juga tidak diterima; tulis teksnya apa adanya.
- Batas: 5 detik per statement, 2 detik menunggu lock, maksimal 500 baris dan 100 kolom yang ditampilkan, nilai yang
  panjang dipotong di 2.000 karakter.
- Setiap run diperiksa dulu di server, lalu dijalankan di dalam transaksi `READ ONLY` yang di-rollback. Database
  menegakkannya sekali lagi lewat role.
- Setiap run diaudit di Events dengan alias database dan fingerprint query-nya, tidak pernah dengan teks query-nya.
- Snippet bawaan: tabel berdasarkan ukuran, koneksi aktif, query lambat (butuh extension `pg_stat_statements`), cache
  hit ratio, jumlah baris (perkiraan). Snippet buatan Anda sendiri hanya disimpan di browser Anda (sampai 30), bukan di
  Watchbell.

## Postgres untuk pengguna MySQL

Supabase dan Neon menjalankan Postgres. Kalau Anda terbiasa dengan MySQL, inilah perbedaan yang akan pertama kali Anda
temui:

| Anda ingin | MySQL | Postgres (bisa dipakai di sini) |
|---|---|---|
| Daftar tabel | `SHOW TABLES;` | `select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2;` |
| Kolom sebuah tabel | `DESCRIBE users;` | `select column_name, data_type, is_nullable from information_schema.columns where table_name = 'users' order by ordinal_position;` |
| Index sebuah tabel | `SHOW INDEX FROM users;` | `select indexname, indexdef from pg_indexes where tablename = 'users';` |
| Daftar database | `SHOW DATABASES;` | `select datname from pg_database;` (sebuah koneksi selalu ke satu database) |
| Query yang sedang berjalan | `SHOW PROCESSLIST;` | snippet "Active connections" (`pg_stat_activity`) |
| Memberi kutip pada nama | `` `Order` `` | `"Order"` (nama tanpa kutip diubah menjadi huruf kecil) |
| Nilai teks | `'text'` atau `"text"` | hanya `'text'`; kutip ganda untuk nama |
| Melewati dan mengambil baris | `LIMIT 20, 10` | `LIMIT 10 OFFSET 20` |
| Nilai cadangan untuk null | `IFNULL(a, b)` | `coalesce(a, b)` |
| Pencocokan tanpa membedakan huruf besar-kecil | `LIKE` (tergantung collation) | `ILIKE` |

Hal lain yang perlu diketahui:

- `SHOW` di Postgres menampilkan sebuah setting (`show server_version;`), bukan tabel.
- Shortcut psql seperti `\dt` dan `\d users` adalah perintah program psql, bukan SQL; keduanya tidak bisa dipakai di
  sini.
- Tabel Anda biasanya ada di schema `public`. Role ini hanya punya akses ke `public`, jadi schema milik Supabase sendiri
  (`auth`, `storage`) tidak terlihat.

## Firestore

Tab **Firestore** menampilkan root collection Anda dan menyusun query sederhana (sebuah collection, kondisi field,
urutan) lalu menjalankannya dengan service account dari akun Firebase, yang butuh `datastore.viewer` di project itu.
Setiap query dihitung terhadap jatah read Firestore gratis Anda; tab ini menampilkan jumlah read hari ini.

## Mencabut akses

Di tab SQL access, **Remove** menghapus connection string yang tersimpan. Hapus juga role-nya di database:

```sql
drop owned by watchpost_ro;
drop role watchpost_ro;
```
