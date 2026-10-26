# AI

English: [../ai.md](../ai.md)

Watchbell tidak punya AI sendiri dan tidak ada akun AI di belakangnya. Setiap fitur AI memakai **key provider milik
Anda sendiri**, jadi tidak ada biaya sampai Anda menambahkan key, dan setelah itu yang terpakai adalah kuota provider
Anda. Semua yang dibahas di sini ada di **Manage › AI Gateway** (khusus owner).

- [Menambah provider](#menambah-provider)
- [Yang memakai AI](#yang-memakai-ai)
- [Model, kuota, dan log](#model-kuota-dan-log)
- [API key](#api-key)
- [Gateway: AI untuk aplikasi Anda sendiri](#gateway-ai-untuk-aplikasi-anda-sendiri)
- [MCP: menghubungkan AI agent](#mcp-menghubungkan-ai-agent)
- [Apa yang keluar dari mesin Anda](#apa-yang-keluar-dari-mesin-anda)

## Menambah provider

Buka **AI Gateway › Bring your own key** lalu hubungkan salah satu dari:

| Provider | Yang Anda tempel | Tempat mendapatkannya |
|---|---|---|
| Google Gemini | API key AI Studio (diawali `AQ.` atau `AIza`) | https://aistudio.google.com/apikey |
| Cloudflare Workers AI | API token dengan **Workers AI: Read**, dan account ID Anda (ada di halaman Workers AI) | https://dash.cloudflare.com/profile/api-tokens |
| Custom OpenAI-compatible (di bawah Advanced) | Base URL server dan API key | Server apa pun yang mendukung OpenAI chat completions API dan menjawab `GET /models`, di internet atau di mesin maupun jaringan Anda sendiri (Ollama, LM Studio, dan lainnya) |

Catatan:

- Watchbell menawarkan model Google: Gemini dari Google, dan model Gemma dari Google di Cloudflare Workers AI. Server
  custom menawarkan semua model yang ada di daftarnya.
- Server custom boleh memakai `http://` atau `https://` di port mana pun: alamat publik, atau alamat di mesin maupun
  jaringan Anda sendiri (`localhost`, `127.x`, `10.x`, `172.16.x` sampai `172.31.x`, `192.168.x`, `*.local`). Misalnya
  Ollama di `http://localhost:11434/v1` atau LM Studio di `http://localhost:1234/v1`. Alamat link-local dan alamat
  metadata cloud (`169.254.x`) ditolak.
- Server lokal biasanya tidak butuh key, tetapi form-nya meminta key minimal 8 karakter: ketik placeholder apa saja,
  misalnya `ollama-local`.
- Satu connection menjadi default. Key dienkripsi dengan `OPS_ENCRYPTION_KEY`, tidak pernah dikirim ke browser dan
  tidak pernah dicatat di log, dan Watchbell tidak pernah berganti-ganti akun.

Sampai sebuah provider terhubung, setiap halaman AI Gateway menampilkan banner "No provider connected" dan fitur AI di
bawah tidak aktif.

## Yang memakai AI

Setelah sebuah provider terhubung:

- **Ask** (AI Gateway › Ask): pertanyaan tentang console Anda ("aplikasi mana yang down minggu ini, dan kenapa?"),
  dijawab oleh provider Anda berdasarkan snapshot data console yang sudah dibersihkan. Pertanyaan disimpan 7 hari.
- **Advisor notes**: dua kali sehari, pukul 07:00 dan 19:00 di zona waktu Anda, satu panggilan ke provider menulis
  catatan singkat tentang aplikasi yang perlu diperhatikan. Catatan ini tampil di Overview dan di halaman aplikasi.
  Matikan, atau pilih model-nya, di **AI Gateway › Models**.
- **Ringkasan dan penjelasan**: ringkasan harian singkat dari rekomendasi, dan penjelasan AI untuk masalah sebuah
  aplikasi, masing-masing dibuat dengan model default Anda.
- **Playground**: coba sebuah model dengan session owner Anda. "Plain" hanya mengirim pesan Anda; "Ask the console"
  menambahkan snapshot aplikasi Anda yang sudah dibersihkan. Tidak ada yang disimpan.

Kalau provider yang dituju tidak bisa dihubungi (endpoint atau tunnel-nya mati: timeout, error jaringan, atau 502, 503,
504, 52x, 530), kena batas pemakaian (429), gagal karena error server lain (misalnya 500), atau mengirim jawaban yang
tidak bisa dibaca Watchbell, Watchbell mencoba provider aktif berikutnya satu kali. Kunci yang ditolak (401 atau 403)
atau request yang ditolak provider tidak pernah dicoba ulang, provider yang Anda matikan tidak pernah dipakai, dan
model yang Anda pilih langsung (Playground, atau model yang dipilih di Ask) tetap di provider-nya. Panggilan yang punya
batas waktu tetap di dalam batas itu: selama ada provider lain yang aktif, provider pertama mendapat dua pertiga
waktunya (untuk batas 9 detik atau lebih), jadi provider yang macet masih menyisakan waktu untuk yang kedua. Kalau
tidak ada yang menjawab, pesannya menyebut nama provider-nya, misalnya
`AI provider "my-router" is unreachable (its endpoint or tunnel is down).`, dan apakah provider lain sudah dicoba atau
memang tidak ada (tambahkan di **Bring your own key**).

## Model, kuota, dan log

- **Models** menampilkan model yang ditawarkan tiap provider yang terhubung (`/models` miliknya). Matikan sebuah model,
  dan request untuk model itu ditolak dengan `400 model_not_enabled`. Model id berbentuk `provider/model`; id tanpa
  prefiks dikirim ke provider default.
- **Quota** menampilkan apa yang dikerjakan tiap provider lewat Watchbell dan batas masing-masing console key. Gemini
  dan Cloudflare tidak melaporkan batasnya, jadi Watchbell menghitung request terhadap batas yang Anda isi untuk
  connection tersebut.
- **Usage** menampilkan jumlah token (input, cached, output) sesuai laporan tiap provider.
- **Logs** hanya menyimpan metadata: waktu, key, client, model, token, latency, dan hasil. Prompt dan jawaban tidak
  pernah disimpan. Disimpan 30 hari.

## API key

Aplikasi dan AI agent Anda sendiri berkomunikasi dengan Watchbell lewat **console API key** (AI Gateway › API keys).
Key diawali `wp_`, ditampilkan sekali, dan Watchbell hanya menyimpan hash SHA-256 dan prefiks pendeknya untuk
membedakan key satu dengan yang lain. Mencabut sebuah key menghentikannya dalam satu menit.

Setiap key punya scope:

| Scope | Mengizinkan |
|---|---|
| `ai:invoke` | Chat completions dan daftar model lewat connection provider Anda (default) |
| `read:status` | Data console read-only: `GET /api/v1/status` dan server MCP. Nama database berupa alias; tanpa URL, email, atau secret |
| `write:notes` | Mati kecuali Anda mencentangnya. Mengizinkan agent memposting AI notes dan menjawab pertanyaan dari Ask. Tidak lebih |

Anda juga memilih masa berlaku (7 hari sampai tidak pernah kedaluwarsa; default 90 hari) dan rate limit per menit
(default 20, maksimal 600). Paling banyak 20 key bisa aktif. **API explorer** mendokumentasikan setiap endpoint dan
memungkinkan Anda mencobanya dengan sebuah key.

## Gateway: AI untuk aplikasi Anda sendiri

Watchbell menyediakan API yang kompatibel dengan OpenAI di depan connection provider Anda. Arahkan OpenAI client ke
`<SITE_URL>/api/v1/ai` dengan key yang punya `ai:invoke`:

```bash
curl http://localhost:3100/api/v1/ai/chat/completions \
  -H "Authorization: Bearer $WATCHBELL_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Client: my-app/1.0" \
  -d '{"model": "gemini/gemini-3.8-flash", "messages": [{"role": "user", "content": "Hello"}]}'
```

Pakai model id dari AI Gateway › Models; contoh di atas memanggil model Gemini pada connection bernama gemini.
`GET /api/v1/ai/models` menampilkan model yang bisa dipakai key Anda. Watchbell menerapkan rate limit key itu,
mencatat panggilannya di Logs, dan menampilkan pemanggilnya di bawah Agents. Header `X-Client` (opsional) memberi nama
aplikasi Anda di sana.

Di laptop, gateway hanya bisa dijangkau dari mesin itu sendiri kecuali Anda mengaktifkan
[akses LAN](configuration.md#akses-lan).

## MCP: menghubungkan AI agent

AI agent yang mendukung Model Context Protocol (MCP) bisa membaca console Anda lewat server MCP Watchbell:

- URL: `<SITE_URL>/api/v1/mcp` (Streamable HTTP), misalnya `http://localhost:3100/api/v1/mcp`.
- Header: `Authorization: Bearer <key>`, dengan key yang punya `read:status`.

**AI Gateway › Connect an agent** menampilkan konfigurasi siap tempel untuk client yang umum. Contohnya, Gemini CLI:

```bash
gemini mcp add --transport http watchbell http://localhost:3100/api/v1/mcp \
  --header "Authorization: Bearer $WATCHBELL_API_KEY"
```

Client yang hanya mendukung stdio bisa memakai `mcp-remote`:

```bash
npx mcp-remote http://localhost:3100/api/v1/mcp --header "Authorization: Bearer $WATCHBELL_API_KEY"
```

Agent mendapat tool read-only (`list_apps`, `get_app`, `list_alerts`, `list_monitors`, `recent_events`,
`recent_logs`, `list_databases`, `get_advisor`, `list_pending_questions`) dan, hanya dengan `write:notes`, tool untuk
memposting catatan dan menjawab pertanyaan. Agent tidak bisa mengubah apa pun selain itu. Agent muncul di bawah
**Agents** setelah request pertamanya, dengan nama dari nama client MCP-nya, header `X-Client`, atau User-Agent-nya.

## Apa yang keluar dari mesin Anda

Fitur AI mengirim snapshot data console yang **sudah dibersihkan** ke provider Anda: database disebut dengan alias
(db-a, db-b), tanpa email, tanpa token, tanpa connection string. Request dari aplikasi Anda sendiri lewat gateway
diteruskan apa adanya. Tidak ada yang dikirim ke proyek Watchbell.
