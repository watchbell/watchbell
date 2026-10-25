# Notifikasi

English: [../notifications.md](../notifications.md)

Watchbell bisa mengirim alert ke Telegram, ke channel Discord, dan sebagai email harian. Ketiganya gratis dan opsional,
dan disiapkan di **Alerts › Notifications** (khusus owner; user lain hanya melihat statusnya).

- [Apa yang dikirim](#apa-yang-dikirim)
- [Telegram](#telegram)
- [Discord](#discord)
- [Ringkasan email harian](#ringkasan-email-harian)
- [Bahasa](#bahasa)
- [Aturan senyap](#aturan-senyap)

## Apa yang dikirim

- **Telegram dan Discord:** satu pesan per run collector, berisi setiap alert yang baru terbuka, masih firing (diulang
  setiap 6 jam), atau sudah resolved. Usulan dan hasil auto-action juga dikirim ke Telegram (lihat
  [Auto-actions](auto-actions.md)).
- **Ringkasan email:** satu email per hari pukul 07:00 di [zona waktu](configuration.md#zona-waktu) Anda: apa yang
  firing, apa yang resolved, uptime, dan error yang tersimpan selama 24 jam terakhir.

Setiap channel punya tombol **Send test**, dan sakelar untuk mematikannya tanpa menghapus pengaturannya. Kalau
pengiriman gagal, alasannya ditampilkan di bawah channel tersebut.

## Telegram

1. Di Telegram, chat dengan [@BotFather](https://t.me/BotFather), kirim `/newbot`, lalu ikuti pertanyaannya. BotFather
   memberi Anda bot token seperti `123456789:AA…`.
2. Masukkan token itu ke `app/.env` lalu restart Watchbell:

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AA...
   ```

3. Buka bot baru Anda di Telegram lalu kirim `/start`. Untuk grup, tambahkan bot ke grup lalu kirim pesan di sana.
4. Di Watchbell: **Alerts › Notifications › Telegram bot › Connect**, tekan **Find chats**, pilih chat-nya, lalu
   simpan.
5. Tekan **Send test**.

Jaga kerahasiaan token itu: siapa pun yang memegangnya bisa mengirim pesan atas nama bot Anda.

### Tombol approval

Dengan tombol approval aktif, pesan usulan mendapat tombol **Approve** dan **Reject**, jadi Anda bisa menyetujui
perbaikan dari ponsel. Hanya akun Telegram yang sudah Anda tautkan yang bisa memakainya, dan aksi berisiko meminta
konfirmasi dua kali.

1. Di channel Telegram, di bawah **Approval buttons**, tekan **Turn on**.
2. Tekan **Show link code** lalu kirim `/link <code>` di chat yang terhubung dalam 10 menit. Kodenya hanya bisa
   dipakai sekali.

### Cara tombol sampai ke laptop

Biasanya Telegram mengirim tekanan tombol ke alamat HTTPS publik (webhook). Laptop tidak punya alamat seperti itu, jadi
Watchbell yang self-hosted meminta update baru ke Telegram sendiri (polling) setiap beberapa detik selama tombol
approval aktif. Anda tidak butuh alamat publik, tunnel, atau akun tambahan apa pun.

Yang perlu diketahui:

- Tombol hanya bekerja selama Watchbell berjalan. Tekanan tombol yang dilakukan saat Watchbell berhenti atau laptop
  sedang sleep disimpan oleh Telegram (sampai 24 jam) dan diproses saat Watchbell kembali.
- Mengaktifkan tombol menghapus webhook apa pun yang dimiliki bot. Pakai **satu bot per Watchbell**: kalau bot yang sama
  dipakai instalasi lain yang mengandalkan webhook, keduanya akan saling mengambil update. Kalau Watchbell menemukan
  webhook yang tidak dipasangnya sendiri, ia membiarkannya dan mencatat "Telegram has a webhook set; turn approvals on
  in Alerts → Notifications to switch this install to polling" di log.
- Selama tombol aktif, Telegram menyerahkan setiap pesan ke Watchbell, jadi **Find chats** menampilkan chat yang
  dilihat bot sejak Anda mengaktifkan tombol. Kirim pesan ke bot dulu kalau ada chat yang tidak muncul.
- Anda selalu bisa menyetujui di halaman Auto-actions sebagai gantinya.

## Discord

1. Di Discord: Channel settings › Integrations › Webhooks › New webhook › **Copy Webhook URL**.
2. Di Watchbell: **Alerts › Notifications › Discord webhook › Connect**, tempel seluruh URL-nya lalu simpan.
3. Tekan **Send test**.

URL-nya dienkripsi sebelum disimpan dan tidak pernah ditampilkan lagi. Siapa pun yang memegang URL itu bisa mengirim
pesan ke channel tersebut, jadi perlakukan seperti password. Discord menerima pesan yang sama dengan Telegram, tanpa
tombol.

## Ringkasan email harian

Ringkasan dikirim lewat [Resend](https://resend.com). Paket gratisnya mengizinkan 100 email per hari; Watchbell
mengirim satu.

1. Buat akun Resend lalu verifikasi domain milik Anda (Resend › Domains). Tanpa domain yang terverifikasi, Resend hanya
   mengirim ke alamat akun Resend Anda sendiri.
2. Buat API key dengan **Sending access** saja (diawali dengan `re_`).
3. Tambahkan keduanya ke `app/.env` lalu restart Watchbell:

   ```bash
   RESEND_API_KEY=re_...
   DIGEST_FROM=Watchbell <noreply@your-domain.example>
   ```

   `DIGEST_FROM` harus memakai domain yang sudah Anda verifikasi.
4. Di Watchbell: **Alerts › Notifications › Daily email digest**, isi alamat tujuan lalu simpan.
5. Tekan **Send test**.

## Bahasa

Setiap channel punya bahasanya sendiri: **English** atau **Bahasa Indonesia**. Pilih di samping channel-nya. Ini hanya
mengubah apa yang dikirim Watchbell; web console tetap dalam bahasa Inggris.

## Aturan senyap

Aturan ini bawaan dan tidak bisa diubah. Aturan ini menjelaskan kenapa sebuah pesan mungkin tidak sampai:

- Selama **CollectorStale** firing (collector berhenti berjalan), tidak ada alert lain yang dikirim, karena datanya
  sudah basi.
- Database yang di-pause membungkam **MonitorDown** dan **HighLatency** untuk aplikasi yang terhubung dengannya.
- Pengecekan ke domain yang sudah bukan milik aplikasinya memunculkan **MonitorDomainMoved** (warning), bukan
  **MonitorDown**, dan tidak ada usulan redeploy untuknya: aplikasinya pindah, bukan mati.
- Sebuah alert baru resolved setelah 2 pengecekan berturut-turut berhasil, jadi situs yang naik-turun tidak membuat Anda
  dihubungi dua kali.
- Alert di dalam maintenance window sama sekali tidak dibuka (lihat [Halaman › Uptime](pages.md#hosting)).
- Alert yang di-silence tidak mengirim apa pun sampai masa silence-nya berakhir.

Kalau tidak ada yang sampai sama sekali, lihat
[Troubleshooting](troubleshooting.md#tidak-ada-notifikasi-yang-masuk).
