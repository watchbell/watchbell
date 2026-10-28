# Dokumentasi Watchbell

English: [../README.md](../README.md)

Watchbell adalah ops console yang Anda jalankan sendiri (self-hosted). Anda menjalankannya di laptop atau server Anda
sendiri, ia memantau aplikasi, database, dan domain yang Anda hubungkan, lalu memberi tahu Anda saat ada yang rusak.
Halaman-halaman ini menjelaskan cara memasangnya dan cara memakai setiap bagiannya. Kalau ingin melihat-lihat dulu,
[README proyek](../../README.md#features) berisi screenshot halaman-halaman utamanya.

## Mulai di sini

1. [Instalasi](install.md): installer Linux dan Windows, langkah manual untuk macOS, upgrade, dan uninstall.
2. [Pertama kali dijalankan](first-run.md): kode setup, akun owner, aplikasi authenticator, dan apa yang harus
   dilakukan kalau Anda tidak bisa masuk.
3. [Menghubungkan provider](providers.md): token yang dibutuhkan tiap provider dan izin paling kecil yang sudah cukup.

## Memakai Watchbell

- [Halaman](pages.md): setiap halaman di console dan apa yang ditampilkannya.
- [Notifikasi](notifications.md): Telegram, Discord, webhook, email lewat mail server sendiri, dan ringkasan email harian.
- [Auto-actions](auto-actions.md): perbaikan yang diusulkan untuk alert yang aktif, auto-run yang aman, dan approval
  lewat Telegram.
- [AI](ai.md): key AI provider milik Anda sendiri, gateway, API key, dan server MCP untuk AI agent.
- [Backup](backups.md): ringkasan bulanan di Google Drive Anda, serta cara mem-backup dan me-restore Watchbell itu
  sendiri.
- [SQL console](sql-console.md): query read-only ke database Supabase dan Neon Anda.

## Referensi

- [Konfigurasi](configuration.md): setiap pengaturan di `app/.env`, termasuk akses LAN.
- [Troubleshooting](troubleshooting.md): error yang sering muncul dan cara mengatasinya.
- [FAQ](faq.md)

## File lain

- [README proyek](../../README.md)
- [Panduan kontribusi](../../CONTRIBUTING.md)
- [Kebijakan keamanan](../../SECURITY.md)
- [Changelog](../../CHANGELOG.md)
- [Catatan developer untuk aplikasi](../../app/README.md)

Dokumentasi ini juga tersedia online di [watchbell.west-solutions.web.id/id/docs](https://watchbell.west-solutions.web.id/id/docs)
([dalam bahasa Inggris](https://watchbell.west-solutions.web.id/docs)).
