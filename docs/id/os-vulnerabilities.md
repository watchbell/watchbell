# OS vulnerabilities

English: [../os-vulnerabilities.md](../os-vulnerabilities.md)

DevOps › Security › **OS vulnerabilities** menampilkan kerentanan yang diketahui di mesin tempat Watchbell self-hosted
berjalan, masing-masing dengan skornya, cara memperbaikinya, dan tautan ke vendor serta komunitas. Untuk sekarang
Ubuntu; Debian menyusul. Edisi cloud tidak bisa melihat mesin, jadi halaman ini hanya ada di edisi self-hosted.

## Yang dicek

- **Kernel.** Kernel yang sedang berjalan, kernel terbaru yang terpasang, dan update kernel yang menunggu di apt. Kalau
  kernel yang lebih baru sudah terpasang tapi belum berjalan, halaman ini meminta reboot. Ubuntu mencatat ribuan CVE
  kernel; menjalankan kernel terbaru yang dirilis Ubuntu adalah cara memperbaikinya, jadi CVE-nya tidak didaftar satu
  per satu. Kartunya menautkan notice kernel dari Ubuntu.
- **Security updates waiting.** Setiap paket yang punya update di apt dari repository Ubuntu sendiri. Untuk masing-masing, data keamanan Ubuntu
  menyebutkan CVE mana yang diperbaiki update itu: CVE-nya, skor CVSS (0–10), prioritas Ubuntu, dan tautan ke halaman
  CVE Ubuntu, Ubuntu Security Notice (USN), dan NVD. Ada perintah untuk di-copy yang meng-upgrade paket itu saja, dan
  satu lagi untuk semuanya.
- **Other updates.** Update yang bukan perbaikan keamanan (perbaikan bug, repository lain), dilipat.
- **No fix yet.** Berapa advisory yang dicatat OSV.dev untuk paket terpasang tanpa perbaikan yang diketahuinya, per
  paket, dilipat. Paket yang punya update menunggu tidak dihitung, karena update itu mungkin memperbaikinya. Sebagian besar berprioritas rendah, ditunda, atau ada di paket universe yang tidak didukung Ubuntu.
  OSV bisa tertinggal dari Ubuntu, jadi setiap paket menautkan tracker Ubuntu untuk status terbarunya.

## Cara kerjanya

Watchbell menjalankan dua perintah read-only di mesin itu, `dpkg-query` (paket terpasang) dan `apt list --upgradable`
(update yang menunggu), serta membaca `/etc/os-release`, kernel yang berjalan, dan `/var/run/reboot-required`. Lalu
Watchbell bertanya ke API keamanan Ubuntu (ubuntu.com/security) tentang paket yang punya update, dan ke OSV.dev tentang
paket terpasang lainnya (selain kernel). Hanya nama dan versi paket yang keluar dari mesin.

Watchbell tidak pernah meng-install, meng-upgrade, atau me-reboot apa pun. Perintah di halaman itu untuk Anda copy dan
jalankan sendiri.

Job harian men-scan mesin itu; owner bisa menekan **Scan now** (butuh paling lama satu menit). Kalau daftar paket apt
sudah lebih dari dua hari, halaman ini memberi tahu: jalankan `sudo apt update`, atau ada update yang tidak terlihat.
Scan yang gagal tetap menyimpan hasil terakhir yang berhasil dan menyebutkan kapan dan kenapa gagal.

## Alert-nya

**OsSecurityUpdate** (warning, section DevOps) menyala selama ada update keamanan yang menunggu dan memperbaiki CVE
dengan skor 7.0 ke atas, atau kernel yang lebih baru menunggu reboot. Skor 9.0 ke atas membuatnya critical. Ubah
skornya di Manage › Alerts (bilangan bulat; 0 berarti setiap perbaikan yang punya skor). Kalau perbaikan sebuah update gagal dibaca, alert tetap
menyala untuk perbaikan yang berhasil dibaca, tapi tidak resolved sampai scan berhasil membaca semuanya. Alert itu resolved setelah Anda meng-install
update-nya, reboot kalau perlu, dan scan berikutnya berjalan.

## Siapa yang melihatnya

Operator dan owner; Scan now milik owner. Di demo, halaman ini menampilkan mesin karangan dengan catatan CVE publik yang
asli, dan Scan now dimatikan.
