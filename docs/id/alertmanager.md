# Alertmanager

English: [../alertmanager.md](../alertmanager.md)

Prometheus Alertmanager bisa mengirim alert-nya ke Watchbell. Alert itu dibuka, diulang, dan selesai dengan notifikasi
yang sama seperti alert Watchbell sendiri (Telegram, Discord, webhook, email, ringkasan harian, Ask AI), dan muncul di
**Alerts › Firing** dengan sumber **Alertmanager**. Disiapkan di **Alerts › Sources** (khusus owner; user lain hanya
melihat statusnya). Demo tidak punya fitur ini, karena fitur ini menerima alert dari internet.

- [Menyiapkan](#menyiapkan)
- [Cara alert dipetakan](#cara-alert-dipetakan)
- [Batas dan jawaban](#batas-dan-jawaban)
- [Ganti, cabut, dan tes](#ganti-cabut-dan-tes)

## Menyiapkan

1. Buka **Alerts › Sources** lalu tekan **Set up Alertmanager**. Watchbell membuat URL webhook rahasia dan
   menampilkannya **sekali saja**: salin sebelum lanjut. Siapa pun yang punya URL ini bisa mengirim alert ke console
   Anda, jadi simpan hanya di `alertmanager.yml`.
2. Gabungkan kedua bagian ke `alertmanager.yml` (wizard sudah mengisi URL-nya), lalu reload Alertmanager
   (`curl -X POST localhost:9093/-/reload`):

   ```yaml
   # 1. Di bawah receivers:
   receivers:
     - name: watchbell
       webhook_configs:
         - url: https://monitor.example.com/api/alertmanager/am_…
           send_resolved: true
           max_alerts: 100

   # 2. Sebagai entri pertama routes: di route Anda (receiver dan route Anda sendiri tetap seperti semula)
   route:
     routes:
       - receiver: watchbell
         continue: true
         repeat_interval: 4h
   ```

   `send_resolved: true` membuat Watchbell menutup alert waktu Alertmanager menutupnya. `max_alerts: 100` menjaga satu
   kiriman tetap di dalam batas Watchbell. `continue: true` membuat semua alert tetap terkirim juga ke receiver Anda
   yang lain. Jaga `repeat_interval` di bawah 24 jam; kalau lebih, alert yang masih firing akan ditutup sebagai stale
   di sini lalu terbuka lagi. Kalau hanya sebagian alert yang mau dikirim ke Watchbell, tambahkan `matchers` di route-nya.
3. Kirim alert tes, misalnya `amtool alert add WatchbellTest severity=info --alertmanager.url=http://localhost:9093`.
   Wizard mengecek tiap 5 detik selama 2 menit dan menampilkan **Received** begitu alert-nya masuk.

Alertmanager harus bisa menjangkau alamat console Anda. Watchbell self-host di jaringan sendiri tetap bisa, asalkan
Alertmanager bisa membuka URL-nya.

## Cara alert dipetakan

| Alertmanager | Watchbell |
|---|---|
| Label `alertname` dan `job` (kalau tidak ada, `instance`) | Judul alert, misalnya `HighErrorRate · pos-api` |
| Annotation `summary` (kalau tidak ada, `description`) | Pesan, maksimal 500 karakter; token, password, dan alamat email disembunyikan |
| Label `severity` | `critical` dan `warning` apa adanya, selain itu `info`; kalau tidak ada, ikut default rule ExternalAlert |
| Fingerprint | Satu alert per fingerprint: kiriman ulang memperbarui alert yang terbuka, tidak membuka alert kedua |
| Label | Disimpan (maksimal 20, nilai sampai 200 karakter) di bawah **Labels** di Firing |
| `status: resolved` | Menutup alert |

Semuanya memakai rule **ExternalAlert** (**Alerts › Rules**): kalau dimatikan, alert dari Alertmanager tidak membuka
apa pun; channel-nya juga dipilih di sana. Silence berlaku seperti rule lain, dan maintenance window untuk **semua**
app menahan alert baru.

Alert yang 24 jam tidak dikabarkan lagi oleh Alertmanager ditutup sebagai stale (Alertmanager mengulang alert yang
masih firing tiap `repeat_interval`, default 4 jam). Kiriman resolved untuk alert yang belum pernah dibuka Watchbell
tidak mengubah apa pun.

## Batas dan jawaban

Maksimal 256 KB dan 100 alert per kiriman, dan 120 alert per menit per sumber.

| Jawaban | Kapan |
|---|---|
| `200 {"accepted": n}` | Diterima |
| `400` | Bukan body webhook Alertmanager versi 4, atau lebih dari 100 alert |
| `404` | URL tidak dikenal atau sudah dicabut |
| `413` | Body lebih dari 256 KB |
| `429` | Lebih dari 120 alert per menit; Alertmanager mengulang setelah `Retry-After` |
| `503` | Watchbell gagal menyimpan; Alertmanager mengulang |

Watchbell hanya menyimpan hash dari bagian rahasia URL dan 7 karakter pertamanya, dan tidak pernah mencatat body ke log.

## Ganti, cabut, dan tes

- **Replace URL** membuat URL baru (ditampilkan sekali) dan langsung mematikan URL lama. Pasang yang baru di
  `alertmanager.yml`.
- **Revoke** mematikan URL: kiriman Alertmanager dijawab 404. Alert yang sudah terbuka tetap terbuka sampai selesai,
  atau sampai 24 jam tanpa kabar.
- **Send a test alert** membuka alert `info` bernama WatchbellTest lewat jalur yang sama dengan alert sungguhan, jadi
  Anda bisa melihat ke mana alert dikirim. Alert ini selesai sendiri setelah sekitar 5 menit.

Kartunya juga menampilkan alert terakhir, jumlah bulan ini (diterima dan ditolak), dan lima alert terakhir yang
masuk. Statusnya **quiet** kalau 7 hari tidak ada yang masuk; itu wajar kalau memang tidak ada yang firing.
