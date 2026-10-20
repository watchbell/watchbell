import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { blockedHostname, isBlockedAddress } from "@/lib/net/public-host";

// TLS expiry (spec §7.6): one handshake per custom domain a day. Held to the monitors' SSRF rules: the name is
// resolved first, ANY private address refuses it, and the socket connects to the checked address with SNI set to
// the name, so no second lookup can be rebound. rejectUnauthorized is off so an expired or untrusted certificate is
// still read and reported (authorized: false). No HTTP request is sent.

type FakeSocket = {
  on(ev: "secureConnect" | "error" | "timeout", fn: (...a: unknown[]) => void): unknown;
  getPeerCertificate(): Record<string, unknown>;
  authorized: boolean;
  authorizationError?: unknown;
  end(): void;
  destroy(): void;
};
export type ConnectFn = (opts: { host: string; port: number; servername: string; rejectUnauthorized: boolean; timeout: number; ALPNProtocols: string[] }) => FakeSocket;
export type CertResult = { ok: true; notAfter: Date; issuer: string | null; authorized: boolean; authError: string | null } | { ok: false; error: string };

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// OpenSSL's text form, e.g. "Dec  9 23:59:59 2026 GMT".
export function parseCertDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$/.exec(s.trim());
  if (!m || MONTHS[m[1]] === undefined) return null;
  return new Date(Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])));
}

function issuerName(cert: Record<string, unknown>): string | null {
  const i = cert.issuer as Record<string, unknown> | undefined;
  const v = i?.O ?? i?.CN;
  return typeof v === "string" && v ? v : null;
}

export async function readCertificate(
  host: string,
  deps: { timeoutMs?: number; lookup?: (h: string) => Promise<string[]>; connect?: ConnectFn } = {},
): Promise<CertResult> {
  const timeoutMs = deps.timeoutMs ?? 5000;
  const name = host.toLowerCase().replace(/\.$/, "");
  if (isIP(name) || blockedHostname(name)) return { ok: false, error: "Blocked address" };
  let addresses: string[];
  try {
    addresses = await (deps.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true, verbatim: true })).map((a) => a.address)))(name);
  } catch {
    return { ok: false, error: "The name doesn't resolve" };
  }
  if (!addresses.length) return { ok: false, error: "The name doesn't resolve" };
  if (addresses.some(isBlockedAddress)) return { ok: false, error: "Blocked address" };
  const connect = deps.connect ?? (tlsConnect as unknown as ConnectFn);
  // Every address passed the check above; an IPv4 one goes first (Vercel's egress is IPv4-only).
  const address = addresses.find((a) => isIP(a) === 4) ?? addresses[0];
  return new Promise<CertResult>((resolve) => {
    let done = false;
    let socket: FakeSocket | undefined;
    const finish = (r: CertResult, s?: FakeSocket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s?.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)} s` }, socket), timeoutMs);
    try {
      socket = connect({ host: address, port: 443, servername: name, rejectUnauthorized: false, timeout: timeoutMs, ALPNProtocols: ["http/1.1"] });
    } catch {
      return finish({ ok: false, error: "Couldn't connect" });
    }
    const sock = socket;
    sock.on("secureConnect", () => {
      const cert = sock.getPeerCertificate();
      const notAfter = parseCertDate(cert.valid_to);
      if (!notAfter) return finish({ ok: false, error: "The certificate has no readable expiry date" }, sock);
      const authError = sock.authorized ? null : String(sock.authorizationError ?? "untrusted");
      finish({ ok: true, notAfter, issuer: issuerName(cert), authorized: sock.authorized, authError }, sock);
    });
    sock.on("timeout", () => finish({ ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)} s` }, sock));
    sock.on("error", () => finish({ ok: false, error: "Couldn't connect" }, sock));
  });
}
