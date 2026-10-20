// Stage 9 slice 3 (moved to the core for the GitHub repository browser): what is cut out of code before any of it leaves
// Watchbell (to the AI provider), is stored in a Dev note or is shown on a repository page.
// Pure. Anything that looks like a secret becomes «redacted»: private key blocks, JWTs, connection strings
// and URLs with a user:password, known token shapes (GitHub, OpenAI, Stripe, Slack, AWS, Google, Supabase, Resend,
// SendGrid, npm, GitLab, Hugging Face, the console's own wb_ (older wp_) / hb_ / wr_ keys…), Bearer / Basic credentials, the value of
// anything named like a key, token, secret or password (quoted, or unquoted in .env style), long random-looking
// literals, and email addresses. Names stay (process.env.DATABASE_URL is kept; its value never appears in code we read).

export const REDACTED = "«redacted»";

const R = REDACTED;

// Order matters: whole blocks and URLs first, then token shapes, then assignments, then the leftovers.
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // PEM / OpenSSH private keys (and any BEGIN … KEY block).
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|KEY)-----[\s\S]*?(?:-----END [A-Z0-9 ]*(?:PRIVATE KEY|KEY)-----|$)/g, R],
  // Connection strings: database / queue URLs whole, and any URL with user:password@.
  [/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|clickhouse|libsql):\/\/[^\s'"`<>]+/gi, R],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>/:@]+:[^\s'"`<>@]+@[^\s'"`<>]+/gi, R],
  // JWTs (Supabase anon / service keys are JWTs too).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, R],
  // Known token shapes.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, R],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\b(?:glpat|npm|hf|gsk|whsec|shpat|shpss|dop_v1|sbp|sb_secret|sb_publishable|re|wb|wp|hb|wr|xai|pplx)[-_][A-Za-z0-9_-]{16,}/g, R],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, R],
  // Authorization header values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g, (_m, kind) => `${kind} ${R}`],
  // name = "value" / name: 'value' where the name says key, token, secret, password…
  [/\b([A-Za-z0-9_$.-]*(?:key|token|secret|passw(?:or)?d|passwd|pwd|credential|auth|dsn|signature|salt)[A-Za-z0-9_$-]*["']?\]?\s*(?:=|:|=>)\s*)(["'`])([^"'`\n]{4,})\2/gi,
    (_m, head, q) => `${head}${q}${R}${q}`],
  // .env style, unquoted: FOO_SECRET=value, DATABASE_URL=…
  [/^(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|DSN|URL|AUTH|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(?!["'`])(\S{4,})/gm, (_m, head) => `${head}${R}`],
  // Long random-looking literals (≥ 32 chars, letters and digits mixed): likely a key even without a telling name.
  [/(["'`])((?=[A-Za-z0-9+/_=-]*[0-9])(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{32,})\1/g, (_m, q) => `${q}${R}${q}`],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, R],
];

export function redactCode(text: string): string {
  let out = String(text ?? "");
  for (const [re, rep] of RULES) out = out.replace(re, rep as never);
  return out;
}

// How many redactions a text got (for the prompt's note and the tests).
export const redactions = (text: string): number => (text.match(/«redacted»/g) ?? []).length;
