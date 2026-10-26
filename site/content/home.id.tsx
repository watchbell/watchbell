import type { HomeCopy } from "./types";

// Indonesian home copy: the same sections and facts as home.en.tsx. Product, page and menu names, commands and the
// terminal output stay as in English; the Telegram buttons use the bot's own Indonesian labels (Setujui, Tolak, Batal).
export const homeId: HomeCopy = {
  title: "Watchbell: mengawasi aplikasi gratisanmu dan bertanya sebelum memperbaiki",
  description:
    "Watchbell mengawasi aplikasi Vercel, database, dan domain kamu di paket gratis, dan bertanya dulu lewat Telegram sebelum memperbaiki apa pun. Gratis, open source, jalan di mesinmu sendiri.",
  hero: {
    clock: "03:12 — orbit-blog berhenti merespons",
    title: "Situsmu mati jam 3 pagi.",
    titleSoft: "Kamu memperbaikinya dari tempat tidur.",
    lede: (
      <>
        Watchbell mengawasi aplikasi Vercel, database, dan domain kamu di paket gratis. Saat ada yang rusak, Watchbell{" "}
        <b>mencari cara memperbaikinya dan bertanya dulu ke kamu</b> lewat Telegram. Dua tap, beres.
      </>
    ),
    setup: "Pasang malam ini",
    docs: "Baca dokumentasi",
    note: (
      <>
        Gratis, open source, jalan di mesin <code>kamu</code> sendiri.
      </>
    ),
  },
  phone: {
    label: "Percakapan Telegram dengan Watchbell",
    bot: "bot",
    first: (
      <>
        <span className="red">orbit-blog mati.</span>
        <br />
        Tidak ada respons di 3 pengecekan berturut-turut. Deploy jam 02:58 kemungkinan besar penyebabnya.
        <br />
        <br />
        Rollback ke deployment sebelumnya?
      </>
    ),
    approve: "Setujui",
    reject: "Tolak",
    sure: "Rollback production. Yakin?",
    yes: "Ya, rollback",
    cancel: "Batal",
    back: (
      <>
        <span className="grn">orbit-blog sudah pulih.</span> Merespons dalam 184 ms. Silakan tidur lagi.
      </>
    ),
  },
  night: {
    eyebrow: "Satu malam bersama Watchbell",
    title: "Yang sebenarnya terjadi.",
    sub: "Semua di bawah ini adalah yang Watchbell lakukan hari ini, di laptop atau server kecil, dengan akun gratis milikmu sendiri.",
    pushed: {
      title: "Kamu push perubahan kecil, lalu tidur.",
      text: "Vercel membangunnya dan menayangkannya. Watchbell melihat deployment baru itu masuk.",
    },
    down: {
      title: "Situsnya berhenti merespons.",
      text: "Watchbell mengecek setiap aplikasi sekali semenit. Tiga kali gagal berturut-turut, jadi situsnya mati, bukan sekadar lambat.",
    },
    asked: {
      title: "Watchbell bertanya. Kamu jawab ya. Dua kali.",
      text: "Perbaikan yang berisiko tidak pernah jalan sendiri. Rollback minta tap kedua, supaya jempol yang masih mengantuk tidak menekannya tanpa sengaja. Semua ini jalan tanpa alamat publik: tanpa webhook, tanpa tunnel.",
    },
    fixed: {
      title: "Pulih, dan sudah dicek.",
      text: "Watchbell me-rollback production ke deployment sehat yang terakhir, lalu mengecek situsnya sekali lagi sebelum menyatakannya beres.",
      response: "respons",
      downFor: "mati selama",
      downForValue: "2 mnt 40 dtk",
      action: "aksi",
      actionValue: "rollback · disetujui kamu",
    },
    morning: {
      title: "Sambil ngopi, versi singkatnya.",
      text: "Email pagi berisi apa saja yang terjadi semalam, plus hal-hal yang sebentar lagi jadi masalah.",
      head: "Dari: Watchbell · Subjek: Ringkasan harian, 21 Okt",
      summary: (
        <>
          <b>1 insiden, sudah beres.</b> orbit-blog mati 03:12–03:14; sudah di-rollback.
        </>
      ),
      items: [
        'Supabase "shop-db": 82% dari batas ukuran database gratis.',
        "status.acme-studio.example: sertifikat diperpanjang dalam 12 hari.",
        'Neon "analytics": 46 dari 100 jam compute terpakai.',
      ],
    },
    desk: {
      title: "Di meja kerja, semuanya ada di satu papan.",
      text: "Buka Watchbell dan seluruh kejadian semalam ada di sana: insidennya, rollback-nya, siapa yang menyetujui, dan kondisi semua yang lain.",
    },
  },
  board: {
    eyebrow: "Papan status",
    title: "Semua aplikasi, database, dan domain. Satu halaman.",
    sub: "Dibaca lewat API milik tiap provider, dengan token yang kamu tempel sekali dan tidak pernah keluar dari mesinmu.",
    label: "Papan status Watchbell",
    status: "Status",
    checked: "dicek 14 dtk lalu · tiap 60 dtk",
    date: "Sel 21 Okt · 09:30",
    cols: ["Nama", "Kondisi", "Detail", "90 hari terakhir"],
    groups: { apps: "Aplikasi · Vercel", databases: "Database", domains: "Domain" },
    apps: [
      { name: "orbit-blog", host: "orbit-blog.example", state: "pulih", kind: "rec", detail: "184 ms · di-rollback 03:14", bad: [89], warn: [40, 41] },
      { name: "acme-shop", host: "shop.example", state: "aktif", kind: "ok", detail: "212 ms", warn: [17] },
      { name: "ember-status", host: "status.ember.example", state: "aktif", kind: "ok", detail: "96 ms", warn: [63, 64] },
    ],
    databases: [
      { name: "shop-db", host: "Supabase · Singapura", state: "82% penuh", kind: "warn", detail: "412 / 500 MB · dijaga tetap aktif" },
      { name: "analytics", host: "Neon · compute tidur", state: "idle", kind: "idle", detail: "46 / 100 CU-h bulan ini" },
    ],
    domains: [
      { name: "status.acme-studio.example", host: "Cloudflare DNS → Vercel", state: "sert. 12 hr", kind: "warn", detail: "registrasi 214 hr" },
      { name: "shop.example", host: "Cloudflare DNS → Vercel", state: "valid", kind: "ok", detail: "sert. 71 hr · registrasi 1 thn" },
    ],
    footLeft: "8 resource · 1 pulih malam ini · 2 perlu perhatian segera",
    footRight: "Data contoh karangan",
    providers: (
      <>
        Bekerja dengan <b>Vercel</b>, <b>Supabase</b>, <b>Neon</b>, <b>Firebase</b>, <b>Turso</b>, <b>Upstash Redis</b>,{" "}
        <b>Cloudflare</b> (DNS dan D1), dan <b>GitHub</b>.
      </>
    ),
  },
  also: {
    eyebrow: "Juga ikut diawasi",
    title: "Masalah yang datang pelan, bukan cuma yang heboh.",
    items: [
      { term: "Batas paket gratis", text: "Pemakaian terhadap setiap batas gratis, dengan peringatan sebelum mentok, bukan sesudahnya.", meter: true },
      {
        term: "Database yang tertidur",
        text: "Proyek Supabase gratis dijeda setelah seminggu sepi. Watchbell memperingatkan di hari ke-5 dan menjaganya tetap aktif. Neon dibaca tanpa membangunkan compute-nya.",
      },
      {
        term: "Sertifikat dan domain",
        text: "Masa berlaku sertifikat dan registrasi, plus peringatan kalau proxy Cloudflare berada di depan Vercel.",
      },
      {
        term: "Cron job kamu",
        text: (
          <>
            Tiap job mem-ping alamatnya sendiri; Watchbell memberi tahu kalau ping-nya telat.{" "}
            <span className="tag">/api/ping/&lt;token&gt;</span>
          </>
        ),
      },
      { term: "Paket yang rentan", text: "Advisory untuk repo GitHub kamu, plus usulan pull request yang memperbarui paketnya." },
      {
        term: "SQL hanya-baca",
        text: "Query ke Supabase dan Neon sebagai role yang tidak bisa menulis, di dalam transaksi yang tetap di-rollback.",
      },
      {
        term: "AI, kalau kamu mau",
        text: "Key Gemini, Workers AI, atau Ollama lokal milikmu sendiri, di balik satu endpoint yang kompatibel dengan OpenAI dan sebuah server MCP. Mati secara bawaan.",
      },
      { term: "Halaman status", text: "Halaman publik opsional dan badge uptime untuk README kamu." },
    ],
  },
  setup: {
    eyebrow: "Pasang malam ini",
    title: "Dua perintah. Tanpa akun.",
    steps: [
      <>
        <b>Pasang Node.js 24</b>, kalau belum punya.
      </>,
      <>
        <b>Pasang Watchbell:</b> <code>npm install -g watchbell</code>. Sudah jadi, tidak ada yang perlu dikompilasi.
      </>,
      <>
        <b>Jalankan:</b> <code>watchbell</code>, lalu buka alamat yang dicetaknya dan masukkan kode sekali pakai.
      </>,
      <>
        <b>Sambungkan Telegram</b> dan tempel token Vercel. Urusan jam 03:12 tadi pun beres.
      </>,
    ],
    copy: "salin perintah install",
    copied: "tersalin",
    installers: "installer untuk Linux dan Windows →",
    terminal: "Terminal",
  },
  fine: {
    eyebrow: "Yang perlu kamu tahu",
    rows: [
      ["Jalan di", "Linux, Windows 10/11, dan macOS, dengan Node.js 24. Database-nya sudah termasuk."],
      [
        "Datamu",
        <>
          Tetap di <code>~/.watchbell</code>. Token dienkripsi (AES-256-GCM).
        </>,
      ],
      ["Terhubung ke", "Hanya yang kamu sambungkan, plus npm sekali sehari untuk melihat ada versi baru atau tidak (bisa dimatikan)."],
      ["Saat tidur", "Laptop yang sedang tidur tidak mengecek apa pun. Untuk cerita jam 03:12, jalankan di mesin yang selalu menyala."],
      ["Biaya", "Gratis. Berlisensi MIT."],
    ],
    questions: "Pertanyaan",
    faq: [
      {
        q: "Perlu server?",
        a: "Tidak. Laptop cukup selama menyala. Server rumahan, PC lama, atau VPS kecil memberimu penjagaan sampai jam 3 pagi.",
      },
      {
        q: "Bisa dibuka dari HP?",
        a: (
          <>
            Secara bawaan Watchbell hanya mendengarkan di mesinnya sendiri. Pakai SSH tunnel, atau jalankan dengan{" "}
            <code>--host</code> di jaringan rumahmu. Tombol Telegram tetap berfungsi di kedua cara.
          </>
        ),
      },
      { q: "Ada image Docker?", a: "Belum. Pakai npm atau installer-nya." },
      { q: "Butuh AI?", a: "Tidak. Semua fitur AI opsional dan mati sampai kamu menambahkan key sendiri." },
    ],
  },
};
