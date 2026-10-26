import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { z } from "zod";
import { DEMO_UNAVAILABLE } from "@/lib/demo/simulate";
import { isDemo } from "@/lib/mode";
import { blockedHostname, isBlockedAddress } from "@/lib/net/public-host";
import type { SendResult } from "./telegram";

// 1.2.3 (owner 24 Oct: Office 365, Zimbra): alert messages by email through the user's own mail server, without a
// mail library. The client speaks just enough SMTP: EHLO, STARTTLS (port 587/2525) or TLS from the start (465),
// AUTH PLAIN, one message. The password is only ever sent inside TLS, and the certificate is checked against the host
// name. Like the webhook, the host must be public and its addresses are checked right before connecting, and the
// connection goes to the address that was checked (no second lookup).

export const SMTP_PORTS = [465, 587, 2525] as const;
export type SmtpConfig = { host: string; port: (typeof SMTP_PORTS)[number]; user: string; pass: string; from: string; to: string };

const email = z.email();
export function smtpProblems(c: { host: string; port: number; user: string; pass: string; from: string; to: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const host = c.host.trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,253}$/.test(host) || !host.includes(".")) out.host = "Enter the server name, for example smtp.office365.com.";
  else if (blockedHostname(host)) out.host = "Use a mail server on the public internet. Watchbell doesn't connect into private networks.";
  if (!(SMTP_PORTS as readonly number[]).includes(c.port)) out.port = "Use port 587 (STARTTLS), 465 (TLS) or 2525.";
  if (!c.user.trim() || c.user.length > 200) out.user = "Enter the user name the server expects (often the whole address).";
  if (!c.pass || c.pass.length > 500) out.pass = "Enter the password or app password.";
  if (!email.safeParse(c.from.trim()).success) out.from = "Enter the address the mail comes from.";
  if (!email.safeParse(c.to.trim()).success) out.to = "Enter the address that gets the alerts.";
  return out;
}

// A subject with non-ASCII text (Indonesian alerts, em dashes) as an RFC 2047 encoded word.
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 200);

// The whole message. The body is base64, so no line can start with a dot and nothing needs dot-stuffing.
export function buildMessage(c: Pick<SmtpConfig, "from" | "to" | "host">, subject: string, text: string, now: Date): string {
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: Watchbell <${c.from.trim()}>`, `To: <${c.to.trim()}>`, `Subject: ${header(oneLine(subject))}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@watchbell>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64",
    "", body,
  ].join("\r\n");
}

type Deps = {
  lookup?: (host: string) => Promise<string[]>;
  connect?: (ip: string, port: number, host: string, secure: boolean) => Promise<Duplex>;
  upgrade?: (socket: Duplex, host: string) => Promise<Duplex>;
  timeoutMs?: number;
};

const defaultConnect = (ip: string, port: number, host: string, secure: boolean) => new Promise<Duplex>((resolve, reject) => {
  const s = secure ? tls.connect({ host: ip, port, servername: host }) : net.connect({ host: ip, port });
  s.once(secure ? "secureConnect" : "connect", () => resolve(s));
  s.once("error", reject);
});
const defaultUpgrade = (socket: Duplex, host: string) => new Promise<Duplex>((resolve, reject) => {
  const s = tls.connect({ socket: socket as net.Socket, servername: host });
  s.once("secureConnect", () => resolve(s));
  s.once("error", reject);
});

class Reply {
  private buf = "";
  private lines: string[] = [];
  // Replies that arrived before anyone asked (the greeting can beat the first next()), and callers still waiting.
  private ready: { code: number; text: string }[] = [];
  private waiters: ((r: { code: number; text: string }) => void)[] = [];
  private onData = (d: Buffer) => this.read(d);
  constructor(private socket: Duplex) {
    socket.on("data", this.onData);
  }
  // After STARTTLS the replies come from the TLS stream; the plain socket under it must stop being read as text.
  attach(socket: Duplex) {
    this.socket.off("data", this.onData);
    this.socket = socket;
    socket.on("data", this.onData);
  }
  private read(d: Buffer) {
    this.buf += d.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      // "250-…" continues a reply, "250 …" ends it.
      if (/^\d{3}( |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join("\n") };
        this.lines = [];
        const waiter = this.waiters.shift();
        if (waiter) waiter(reply);
        else this.ready.push(reply);
      }
    }
  }
  next(): Promise<{ code: number; text: string }> {
    const r = this.ready.shift();
    return r ? Promise.resolve(r) : new Promise((resolve) => this.waiters.push(resolve));
  }
  send(line: string) { this.socket.write(`${line}\r\n`); }
}

class SmtpError extends Error {
  constructor(message: string, readonly kind: "config" | "transient") { super(message); }
}

export async function sendSmtp(c: SmtpConfig, subject: string, text: string, deps: Deps = {}): Promise<SendResult> {
  if (isDemo()) return { ok: false, kind: "config", error: DEMO_UNAVAILABLE }; // the demo never sends anything
  if (Object.keys(smtpProblems(c)).length) return { ok: false, kind: "config", error: "The saved mail server settings aren't valid any more." };
  const host = c.host.trim().toLowerCase();
  let ip: string;
  try {
    const all = await (deps.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address)))(host);
    if (!all.length || all.some(isBlockedAddress)) return { ok: false, kind: "config", error: "The mail server resolves to a private address; Watchbell won't connect there." };
    ip = all[0];
  } catch {
    return { ok: false, kind: "transient", error: "The mail server's name didn't resolve." };
  }
  const secure = c.port === 465;
  let socket: Duplex | null = null;
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new SmtpError("The mail server took too long to answer.", "transient")), deps.timeoutMs ?? 15_000).unref?.());
  const run = async (): Promise<void> => {
    try {
      socket = await (deps.connect ?? defaultConnect)(ip, c.port, host, secure);
    } catch {
      throw new SmtpError(`Couldn't connect to ${host}:${c.port}.`, "transient");
    }
    const r = new Reply(socket);
    const expect = async (codes: number[], what: string, kind: "config" | "transient" = "config") => {
      const got = await r.next();
      if (!codes.includes(got.code)) throw new SmtpError(`The mail server refused ${what} (${got.code}).`, got.code >= 400 && got.code < 500 ? "transient" : kind);
      return got;
    };
    await expect([220], "the connection", "transient");
    r.send("EHLO watchbell");
    let ehlo = await expect([250], "EHLO");
    if (!secure) {
      if (!/^250[- ]STARTTLS\b/im.test(ehlo.text)) throw new SmtpError("The mail server doesn't offer STARTTLS on this port, so the password would go in clear. Use port 465 or a server with STARTTLS.", "config");
      r.send("STARTTLS");
      await expect([220], "STARTTLS");
      socket = await (deps.upgrade ?? defaultUpgrade)(socket, host);
      r.attach(socket);
      r.send("EHLO watchbell");
      ehlo = await expect([250], "EHLO after STARTTLS");
    }
    r.send(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass}`, "utf8").toString("base64")}`);
    await expect([235], "the user name or password");
    r.send(`MAIL FROM:<${c.from.trim()}>`);
    await expect([250], "the sender address");
    r.send(`RCPT TO:<${c.to.trim()}>`);
    await expect([250, 251], "the recipient address");
    r.send("DATA");
    await expect([354], "the message");
    socket.write(`${buildMessage(c, subject, text, new Date())}\r\n.\r\n`);
    await expect([250], "the message");
    // The message is already accepted; wait briefly for the goodbye so the server sees a clean QUIT.
    r.send("QUIT");
    await Promise.race([r.next(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  };
  try {
    await Promise.race([run(), timer]);
    return { ok: true };
  } catch (e) {
    return e instanceof SmtpError ? { ok: false, kind: e.kind, error: e.message } : { ok: false, kind: "transient", error: "The mail server closed the connection." };
  } finally {
    (socket as Duplex | null)?.destroy();
  }
}
