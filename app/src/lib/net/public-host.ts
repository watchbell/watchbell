// Which addresses a monitor may point at. Pure and dependency-free (no node:net), because the Add/Edit form validates
// with it in the browser too, and the collector and Check now enforce it again at fetch time (lib/collector/http-check).
// The console fetches what its operators type in, so it must never become a probe into private networks.

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseV4(s: string): [number, number, number, number] | null {
  const m = V4.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? (parts as [number, number, number, number]) : null;
}

// Loopback, private, link-local (incl. the 169.254.169.254 metadata address), CGNAT, IETF protocol assignments
// (192.0.0.0/24), benchmarking, multicast, reserved.
function blockedV4([a, b, c]: [number, number, number, number]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function parseV6(input: string): number[] | null {
  let s = input.split("%")[0].toLowerCase();
  if (!s.includes(":")) return null;
  // An embedded dotted IPv4 tail (::ffff:127.0.0.1) becomes two groups.
  const dot = s.lastIndexOf(".");
  if (dot !== -1) {
    const cut = s.lastIndexOf(":");
    const v4 = parseV4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const group = (part: string) => (part === "" ? [] : part.split(":"));
  const head = group(halves[0]);
  const tail = halves.length === 2 ? group(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function blockedV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  // IPv6 forms that carry an IPv4 address are refused outright (task 6 N2), whatever IPv4 address they carry: a public
  // site never needs them, and translating them back would trust whatever sits behind the translator. parseV6 has
  // already expanded every spelling (dotted or hex tail, compressed or not), so one test per range covers them all.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true; // IPv4-mapped ::ffff:0:0/96
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true; // IPv4-translated ::ffff:0:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true; // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x2002) return blockedV4(v4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local and the old site-local
  return (g[0] & 0xff00) === 0xff00; // multicast
}

// An IPv4 or IPv6 address as text (what a DNS lookup returns). Text that parses as neither is blocked (final review
// M10: the guard fails closed, so an address form this parser doesn't know can never slip through as "public").
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return blockedV4(v4);
  const v6 = parseV6(ip);
  return v6 ? blockedV6(v6) : true;
}

// A hostname as `new URL(...).hostname` gives it (IPv6 in brackets). Names that only exist inside a network, and any
// private or malformed IP literal, are blocked. WHATWG parsing already turns 0x7f.1 or 2130706433 into 127.0.0.1;
// a numeric-looking name that is still not a clean dotted address is refused as well, since no real domain looks so.
export function blockedHostname(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = parseV6(h.slice(1, -1));
    return v6 ? blockedV6(v6) : true;
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return true;
  const v4 = parseV4(h);
  if (v4) return blockedV4(v4);
  const last = h.slice(h.lastIndexOf(".") + 1);
  if (/^(\d+|0x[0-9a-f]*)$/.test(last)) return true; // numeric but not a clean dotted address
  if (!h.includes(".")) return true; // "localhost", "intranet": only resolvable inside a network
  return h === "localhost" || /\.(localhost|local|internal)$/.test(h) || h.endsWith(".home.arpa");
}

// What a monitor URL (and every redirect hop) must satisfy: https, no userinfo, a public host, port 443 only.
export function urlProblem(url: URL): "scheme" | "blocked" | null {
  if (url.protocol !== "https:" || url.username || url.password) return "scheme";
  if (url.port !== "" && url.port !== "443") return "blocked";
  return blockedHostname(url.hostname) ? "blocked" : null;
}

// Self-host only (ruling Q11): an AI provider may run on the user's own machine or network (Ollama, LM Studio, vLLM).
// Says which kind of non-public host a provider URL names: "loopback" (localhost, 127.0.0.0/8, ::1), "private" (10/8,
// 172.16/12, 192.168/16, fc00::/7, *.local), "metadata" (link-local 169.254/16 and fe80::/10, which hold the cloud
// metadata services, plus metadata.google.internal and AWS's fd00:ec2::254), or null for anything else, which the
// caller checks with the public rules above. Monitors, webhooks and every other fetch keep blockedHostname/urlProblem.
export function localProviderHost(hostname: string): "loopback" | "private" | "metadata" | null {
  let h = hostname.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) {
    const g = parseV6(h.slice(1, -1));
    if (!g) return null;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
    if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return "metadata";
    if ((g[0] & 0xffc0) === 0xfe80) return "metadata";
    if ((g[0] & 0xfe00) === 0xfc00) return "private";
    return null;
  }
  if (h === "metadata.google.internal") return "metadata";
  if (h === "localhost") return "loopback";
  if (h.endsWith(".local") && h.length > ".local".length) return "private";
  const v4 = parseV4(h);
  if (!v4) return null;
  const [a, b] = v4;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "metadata";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  return null;
}
