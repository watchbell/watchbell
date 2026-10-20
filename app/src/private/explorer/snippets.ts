import { type ApiOp, bearerEnvOf } from "@/private/openapi/operations";
import type { Row } from "./request";

// Copy-paste snippets for one request (pure). The key and any heartbeat token are NEVER written into a snippet: they
// are read from an environment variable (WATCHBELL_API_KEY, HEARTBEAT_TOKEN), so a snippet is safe to paste anywhere.

export type Snippet = { label: string; code: string };
export type SnippetRequest = { path?: Record<string, string>; query?: Row[]; headers?: Row[]; body?: string };

type Part = { lit: string } | { env: string };
const TOKEN_ENV = "HEARTBEAT_TOKEN";

function urlParts(op: ApiOp, origin: string, req: SnippetRequest): Part[] {
  const parts: Part[] = [];
  const push = (p: Part) => {
    const last = parts.at(-1);
    if (last && "lit" in last && "lit" in p) last.lit += p.lit;
    else parts.push(p);
  };
  let rest = origin.replace(/\/+$/, "") + op.path;
  for (const p of op.params.filter((x) => x.in === "path")) {
    const at = rest.indexOf(`{${p.name}}`);
    push({ lit: rest.slice(0, at) });
    if (p.secret) push({ env: TOKEN_ENV });
    else push({ lit: encodeURIComponent((req.path?.[p.name] ?? "").trim() || p.example || `{${p.name}}`) });
    rest = rest.slice(at + p.name.length + 2);
  }
  push({ lit: rest });
  const qs = new URLSearchParams();
  for (const q of req.query ?? []) if (q.name.trim() && q.value.trim()) qs.append(q.name.trim(), q.value.trim());
  if (qs.size) push({ lit: `?${qs.toString()}` });
  return parts;
}

const bashQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const bashDouble = (s: string) => s.replace(/[\\"$`]/g, "\\$&");
const psDouble = (s: string) => s.replace(/[`"$]/g, "`$&");

const bashUrl = (parts: Part[]) => (parts.some((p) => "env" in p)
  ? `"${parts.map((p) => ("lit" in p ? bashDouble(p.lit) : `\${${p.env}}`)).join("")}"`
  : bashQuote(parts.map((p) => ("lit" in p ? p.lit : "")).join("")));
const psUrl = (parts: Part[]) => `"${parts.map((p) => ("lit" in p ? psDouble(p.lit) : `\${env:${p.env}}`)).join("")}"`;
const jsUrl = (parts: Part[]) => (parts.some((p) => "env" in p)
  ? `\`${parts.map((p) => ("lit" in p ? p.lit.replace(/[\\`]|\$\{/g, "\\$&") : `\${process.env.${p.env}}`)).join("")}\``
  : JSON.stringify(parts.map((p) => ("lit" in p ? p.lit : "")).join("")));

// What goes in the headers apart from the bearer: filled rows, minus the explorer's own X-Client label.
function extraHeaders(req: SnippetRequest, hasBody: boolean): [string, string][] {
  const out = (req.headers ?? []).map((h): [string, string] => [h.name.trim(), h.value.trim()])
    .filter(([n, v]) => n && v && n.toLowerCase() !== "authorization" && !(n.toLowerCase() === "x-client" && v === "api-explorer"));
  if (hasBody && !out.some(([n]) => n.toLowerCase() === "content-type")) out.push(["Content-Type", "application/json"]);
  return out;
}

const compact = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body.trim();
  }
};

export function snippetsFor(op: ApiOp, origin: string, req: SnippetRequest = {}): Snippet[] {
  const parts = urlParts(op, origin, req);
  const method = op.method.toUpperCase();
  const bearer = bearerEnvOf(op);
  const body = op.body !== undefined ? (req.body ?? op.body).trim() : "";
  const headers = extraHeaders(req, body !== "");
  const json = (op.response?.contentType ?? "").includes("json");

  const curl = [
    `curl -X ${method} ${bashUrl(parts)}`,
    ...(bearer ? [`-H "Authorization: Bearer $${bearer}"`] : []),
    ...headers.map(([n, v]) => `-H ${bashQuote(`${n}: ${v}`)}`),
    ...(body ? [`-d ${bashQuote(compact(body))}`] : []),
  ].join(" \\\n  ");

  // curl.exe, never PowerShell's curl alias (Invoke-WebRequest). Double quotes inside the single-quoted body are
  // backslash-escaped, which is what Windows PowerShell hands on to curl.exe.
  const ps = [
    `curl.exe -X ${method} ${psUrl(parts)}`,
    ...(bearer ? [`-H "Authorization: Bearer \${env:${bearer}}"`] : []),
    ...headers.map(([n, v]) => `-H "${psDouble(`${n}: ${v}`)}"`),
    ...(body ? [`--data-raw '${compact(body).replace(/'/g, "''").replace(/"/g, '\\"')}'`] : []),
  ].join(" `\n  ");

  const jsHeaders = [
    ...(bearer ? [`Authorization: \`Bearer \${process.env.${bearer}}\``] : []),
    ...headers.map(([n, v]) => `${/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)}: ${JSON.stringify(v)}`),
  ];
  let jsBody = "";
  if (body) {
    try {
      jsBody = `JSON.stringify(${JSON.stringify(JSON.parse(body), null, 2).replace(/\n/g, "\n  ")})`;
    } catch {
      jsBody = JSON.stringify(body);
    }
  }
  const js = [
    `const res = await fetch(${jsUrl(parts)}, {`,
    `  method: "${method}",`,
    ...(jsHeaders.length ? ["  headers: {", ...jsHeaders.map((h) => `    ${h},`), "  },"] : []),
    ...(jsBody ? [`  body: ${jsBody},`] : []),
    "});",
    `console.log(res.status, await res.${json ? "json" : "text"}());`,
  ].join("\n");

  return [{ label: "curl", code: curl }, { label: "PowerShell", code: ps }, { label: "JavaScript (fetch)", code: js }];
}
