// Notification language (owner 19 Oct): alerts are stored in English (evaluate.ts writes them); when the owner picks
// Indonesian, the text is translated on the way out. One pattern per message shape of each rule; anything the patterns
// don't recognise (a new rule, a reworded message, an alert stored by an older version) goes out unchanged, never half
// translated. Names, numbers and units are kept as they are. translate-id.test.ts builds every rule's message with the
// real evaluators, so a reworded English message fails there.

type Shape = [RegExp, (...m: string[]) => string];

const days = (k: string) => `${k} hari`;
// heartbeat.ts span(): "12 min", "3 h", "4 days".
const span = (s: string) => s.replace(/^(\d+) min$/, "$1 menit").replace(/^(\d+) h$/, "$1 jam").replace(/^(\d+) days?$/, "$1 hari");
const left = (k: string, what: string) => (Number(k) < 0 ? `${what} udah habis.` : `${what} habis dalam ${days(k)}.`);

const HEARTBEAT: Record<string, string> = {
  "the job reported a failure": "job-nya lapor gagal",
  "started but didn't finish": "udah mulai tapi nggak selesai",
  "never pinged": "belum pernah ping",
  "no ping in time": "nggak ada ping tepat waktu",
};

// lib/databases/extra.ts quota labels ("Rows read of 500M this month (org)", "Rows written today of 100k (account)").
const quotaLabel = (s: string) => s
  .replace(/^Rows read/, "baris dibaca").replace(/^Rows written/, "baris ditulis").replace(/^Commands/, "command").replace(/^usage$/, "pemakaian")
  .replace(/ today\b/, " hari ini").replace(/\bof ([^ ]+(?: [A-Z]+)?)\b/, "dari $1").replace(/ this month\b/, " bulan ini").replace(/\(account\)/, "(akun)");

// lib/databases/compute-metrics.ts computeBreaches() phrases.
const computeParts = (s: string) => s
  .replace(/ for (\d+) min/g, " selama $1 menit").replace(/\(limit /g, "(batas ").replace(/\bconnections (\d+) of (\d+)/g, "koneksi $1 dari $2");

const DEP_SEVERITY: Record<string, string> = { critical: "kritis", high: "tinggi", moderate: "sedang", low: "rendah", unknown: "nggak diketahui" };

const SHAPES: Record<string, Shape[]> = {
  MonitorDown: [
    [/^(.+): no ping for (\d+ (?:min|h|days?))\.$/, (_, who, s) => `${who}: nggak ada ping selama ${span(s)}.`],
    [/^(.+): (the job reported a failure|started but didn't finish|never pinged|no ping in time)\.$/, (_, who, why) => `${who}: ${HEARTBEAT[why]}.`],
    [/^(.+) failed its check \((.*)\) on (\d+) consecutive checks\.$/, (_, host, why, k) => `${host}: ${k} cek gagal berturut-turut (${why}).`],
    [/^(.+) returned no answer on (\d+) consecutive checks\.$/, (_, host, k) => `${host}: ${k} cek gagal berturut-turut (nggak ada jawaban).`],
    [/^(.+) returned (HTTP \d+) on (\d+) consecutive checks\.$/, (_, host, code, k) => `${host}: ${k} cek gagal berturut-turut (${code}).`],
    [/^(.+) answers again\.$/, (_, host) => `${host} udah jawab lagi.`],
  ],
  CollectorStale: [
    [/^The collector hasn't finished a run yet\.$/, () => "Collector belum pernah selesai jalan."],
    [/^The last minute run finished ([\d,]+) min ago\.$/, (_, k) => `Collector terakhir selesai jalan ${k} menit lalu.`],
  ],
  HighLatency: [
    [/^p95 ([\d,]+) ms over the last 10 minutes \(limit ([\d,]+) ms\)\.$/, (_, p, lim) => `p95 ${p} ms selama 10 menit terakhir (batas ${lim} ms).`],
  ],
  DeploymentFailed: [
    [/^Production deployment \(no commit\) failed\.$/, () => "Deploy production (tanpa commit) gagal."],
    [/^Production deployment (\S+) failed\.$/, (_, sha) => `Deploy production ${sha} gagal.`],
  ],
  DatabasePaused: [
    [/^Supabase project (.+) is paused\.$/, (_, name) => `Project Supabase ${name} lagi di-pause.`],
  ],
  CertExpiringSoon: [
    [/^The TLS certificate of (.+) expires in (-?\d+) days?\.$/, (_, name, k) => left(k, `Sertifikat TLS ${name}`)],
  ],
  DomainExpiringSoon: [
    [/^(.+) expires in (-?\d+) days?\.$/, (_, name, k) => left(k, name)],
  ],
  StorageAlmostFull: [
    [/^(.+) uses ([\d,]+) MB of ([\d,]+) MB \(([\d,]+)%\)\.$/, (_, name, used, max, p) => `${name} pakai ${used} MB dari ${max} MB (${p}%).`],
  ],
  NeonComputeHigh: [
    [/^(.+) used ([\d,]+) of ([\d,]+) CU-hours this month\.$/, (_, name, used, max) => `${name} udah pakai ${used} dari ${max} CU-hours bulan ini.`],
  ],
  FirestoreQuotaHigh: [
    [/^(.+) hit a Firestore quota \(RESOURCE_EXHAUSTED\)\.$/, (_, name) => `${name} kena kuota Firestore (RESOURCE_EXHAUSTED).`],
    [/^(.+) read ([\d,]+) of ([\d,]+) documents today \(([\d,]+)%\)\.$/, (_, name, r, max, p) => `${name} udah baca ${r} dari ${max} dokumen hari ini (${p}%).`],
  ],
  AutoPauseRisk: [
    [/^No API traffic for (\d+) days?\. Supabase pauses free projects after about 7 days\.$/, (_, k) => `Nggak ada traffic API selama ${days(k)}. Supabase nge-pause project free setelah sekitar 7 hari.`],
  ],
  DnsProxiedToVercel: [
    [/^(.+) points to Vercel through the Cloudflare proxy\. Vercel recommends DNS only\.$/, (_, name) => `${name} ngarah ke Vercel lewat proxy Cloudflare. Vercel nyaranin DNS only.`],
  ],
  DbQuotaHigh: [
    [/^(.+): (.+) at ([\d,]+)% of the free plan\.$/, (_, name, label, p) => `${name}: ${quotaLabel(label)} udah ${p}% dari kuota gratis.`],
  ],
  ComputeHigh: [
    [/^(.+) compute is back under the limits\.$/, (_, name) => `Compute ${name} udah balik di bawah batas.`],
    [/^(.+): ((?:CPU|RAM|disk|connections) .+)\.$/, (_, name, parts) => `${name}: ${computeParts(parts)}.`],
  ],
  CredentialExpiring: [
    [/^Google Drive access was removed \(invalid_grant\)\. Reconnect it\.$/, () => "Akses Google Drive dicabut (invalid_grant). Sambungin lagi ya."],
    [/^The (\S+) credential (.+) has expired\.$/, (_, p, label) => `Credential ${p} ${label} udah kedaluwarsa.`],
    [/^The (\S+) credential (.+) expires in (-?\d+) days?\.$/, (_, p, label, k) => left(k, `Credential ${p} ${label}`)],
  ],
  // lib/deps/plan.ts alertMessage(): "2 vulnerable packages (1 critical, 1 high): next 15.0.0 → 15.0.5, +2 more." (may be
  // cut at 300 characters with "…").
  VulnerableDependency: [
    [/^(.+) has no high or critical dependency advisories\.$/, (_, app) => `${app} nggak punya advisory dependency tinggi atau kritis.`],
    [/^(\d+) vulnerable packages? \(([^)]*)\): (.*)$/, (_, k, counts, rest) =>
      `${k} paket rentan (${counts.replace(/\b(critical|high|moderate|low|unknown)\b/g, (w) => DEP_SEVERITY[w])}): ${rest.replace(/ \(no fix yet\)/g, " (belum ada fix)").replace(/, \+(\d+) more\.$/, ", +$1 lagi.")}`],
  ],
};

export function translateAlertText(ruleKey: string, text: string): string {
  for (const [re, to] of Object.hasOwn(SHAPES, ruleKey) ? SHAPES[ruleKey] : []) {
    const m = re.exec(text);
    if (m) return to(...m);
  }
  return text;
}
