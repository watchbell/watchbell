# Containers

English: [../containers.md](../containers.md)

DevOps › Containers menampilkan container Docker di mesin tempat Watchbell self-hosted berjalan: status, health, port,
dan image-nya. Untuk satu container ditampilkan juga 200 baris log terakhir, satu bacaan CPU dan memori, dan berapa
kali container itu restart. Owner bisa menjalankan, menghentikan, dan me-restart container. Fitur ini hanya ada di
edisi self-hosted.

## Menyalakannya

Akses ke socket Docker setara akses root di mesin itu, jadi Containers mati sampai Anda menyalakannya.

1. Tambahkan `WATCHBELL_DOCKER=on` ke `app/.env` (lihat [Konfigurasi](configuration.md#pengaturan-opsional)).
2. Beri user yang menjalankan Watchbell akses ke socket Docker. Di Linux, masukkan user itu ke grup `docker`
   (`sudo usermod -aG docker <user>`), lalu keluar dan masuk lagi; kalau Watchbell berjalan sebagai service systemd,
   cukup restart service-nya. Di Windows, named pipe Docker Desktop yang dipakai.
3. Restart Watchbell.

Watchbell hanya berbicara dengan Docker lewat socket lokal (`/var/run/docker.sock`, atau `//./pipe/docker_engine` di
Windows). Isi `DOCKER_HOST` dengan alamat `unix://` atau `npipe://` kalau socket Anda ada di tempat lain; alamat
`tcp://` ditolak.

## Apa yang dibaca, dan kapan

Daftarnya dibaca saat Anda membuka halaman atau menekan **Refresh**, dan detail sebuah container saat Anda membukanya.
Tidak ada yang berjalan terjadwal dan Containers tidak memunculkan alert. Baris log yang terlihat seperti rahasia
(token, password, key) disamarkan sebelum ditampilkan. Operator dan owner bisa membuka halaman ini; viewer tidak.

## Apa yang bisa diubah

Hanya owner, dan hanya tiga hal ini:

- **Start** container yang berhenti.
- **Restart** atau **Stop** container yang sedang berjalan. Keduanya meminta Anda mengetik nama container dulu.

Setiap aksi dicatat di Events. Watchbell tidak pernah menghapus container, menjalankan atau masuk (exec) ke container,
menarik atau mem-build image, atau menyentuh volume dan network. Watchbell juga tidak mau menghentikan atau me-restart
container tempat ia sendiri berjalan, kalau ia berjalan di dalam container.
