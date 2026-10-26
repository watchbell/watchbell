import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildMessage, sendSmtp, smtpProblems } from "./smtp";

// A scripted SMTP server on 127.0.0.1. `opts` decides what it offers and refuses; `seen` records every command.
type FakeOpts = { starttls?: boolean; authCode?: number; rcptCode?: number; refuse?: string };
const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

function fakeServer(opts: FakeOpts = {}) {
  const seen: string[] = [];
  let data = "";
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
    let inData = false;
    let buf = "";
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 queued\r\n"); } else data += `${line}\r\n`;
          continue;
        }
        seen.push(line.startsWith("AUTH PLAIN") ? "AUTH PLAIN ***" : line);
        if (line.startsWith("EHLO")) sock.write(`250-fake\r\n${opts.starttls === false ? "" : "250-STARTTLS\r\n"}250 AUTH PLAIN\r\n`);
        else if (line === "STARTTLS") sock.write("220 go ahead\r\n");
        else if (line.startsWith("AUTH PLAIN")) sock.write(`${opts.authCode ?? 235} auth\r\n`);
        else if (line.startsWith("MAIL FROM")) sock.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO")) sock.write(`${opts.refuse && line.includes(opts.refuse) ? 550 : opts.rcptCode ?? 250} ok\r\n`);
        else if (line === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      }
    });
  });
  servers.push(server);
  return new Promise<{ port: number; seen: string[]; data: () => string }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, seen, data: () => data })));
}

const cfg = { host: "smtp.example.com", port: 587 as const, user: "alerts@example.com", pass: "app-password", from: "alerts@example.com", to: "me@example.com" };
const viaFake = (port: number) => ({
  lookup: async () => ["93.184.216.34"],
  connect: () => new Promise<net.Socket>((resolve) => { const s = net.connect(port, "127.0.0.1", () => resolve(s)); }),
  upgrade: async (s: import("node:stream").Duplex) => s, // the fake's STARTTLS keeps the plain socket
  timeoutMs: 5000,
});

describe("SMTP channel (1.2.3)", () => {
  it("checks the settings: a public server, a known port, real addresses", () => {
    expect(smtpProblems(cfg)).toEqual({});
    expect(smtpProblems({ ...cfg, host: "192.168.1.10" })).toHaveProperty("host");
    expect(smtpProblems({ ...cfg, host: "mail.local" })).toHaveProperty("host");
    expect(smtpProblems({ ...cfg, port: 25 })).toHaveProperty("port");
    expect(smtpProblems({ ...cfg, to: "nope" })).toHaveProperty("to");
  });

  it("sends one message: EHLO, STARTTLS, EHLO again, AUTH, MAIL, RCPT, DATA, QUIT", async () => {
    const f = await fakeServer();
    expect(await sendSmtp(cfg, "FIRING · critical · orbit-blog is down", "orbit-blog is down\nNo answer on 3 checks.", viaFake(f.port))).toEqual({ ok: true });
    expect(f.seen).toEqual(["EHLO watchbell", "STARTTLS", "EHLO watchbell", "AUTH PLAIN ***", "MAIL FROM:<alerts@example.com>", "RCPT TO:<me@example.com>", "DATA", "QUIT"]);
    expect(f.data()).toContain("Subject: =?UTF-8?B?");
    expect(f.data()).toContain("Content-Transfer-Encoding: base64");
  });

  it("never sends the password without TLS: no STARTTLS on 587 is refused before AUTH", async () => {
    const f = await fakeServer({ starttls: false });
    const r = await sendSmtp(cfg, "s", "t", viaFake(f.port));
    expect(r).toMatchObject({ ok: false, kind: "config", error: expect.stringMatching(/STARTTLS/) });
    expect(f.seen).not.toContain("AUTH PLAIN ***");
  });

  it("names what the server refused", async () => {
    const f = await fakeServer({ authCode: 535 });
    expect(await sendSmtp(cfg, "s", "t", viaFake(f.port))).toMatchObject({ ok: false, kind: "config", error: expect.stringMatching(/user name or password/) });
    const g = await fakeServer({ rcptCode: 451 });
    expect(await sendSmtp(cfg, "s", "t", viaFake(g.port))).toMatchObject({ ok: false, kind: "transient", error: expect.stringMatching(/recipient/) });
  });

  it("1.2.4: sends one email to several addresses, each one accepted, all in To", async () => {
    const many = { ...cfg, to: "me@example.com, Ops@example.com;ops@example.com  boss@example.com" };
    expect(smtpProblems(many)).toEqual({});
    const f = await fakeServer();
    expect(await sendSmtp(many, "s", "t", viaFake(f.port))).toEqual({ ok: true });
    expect(f.seen.filter((l) => l.startsWith("RCPT"))).toEqual(["RCPT TO:<me@example.com>", "RCPT TO:<Ops@example.com>", "RCPT TO:<boss@example.com>"]);
    expect(f.data()).toContain("To: <me@example.com>, <Ops@example.com>, <boss@example.com>");
  });

  it("1.2.4: a refused address fails the send by its place in the list, before any mail goes out", async () => {
    const f = await fakeServer({ refuse: "typo@" });
    const r = await sendSmtp({ ...cfg, to: "me@example.com, typo@example.con" }, "s", "t", viaFake(f.port));
    expect(r).toEqual({ ok: false, kind: "config", error: "The mail server refused recipient 2 of 2 (550)." });
    expect(f.seen).not.toContain("DATA");
  });

  it("1.2.4: checks every address and the limit of 10", () => {
    expect(smtpProblems({ ...cfg, to: "me@example.com, nope" }).to).toBe("nope isn't a valid address.");
    expect(smtpProblems({ ...cfg, to: " , ; " }).to).toBe("Enter the address that gets the alerts.");
    expect(smtpProblems({ ...cfg, to: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(",") }).to).toBe("Up to 10 addresses.");
  });

  it("refuses a server that resolves to a private address", async () => {
    expect(await sendSmtp(cfg, "s", "t", { lookup: async () => ["10.0.0.25"] })).toMatchObject({ ok: false, kind: "config" });
  });

  it("builds a base64 body, so no line can start with a dot", () => {
    const m = buildMessage(cfg, "Plain subject", ".hidden line\nsecond", new Date("2026-10-26T08:00:00Z"));
    expect(m).toContain("Subject: Plain subject");
    expect(m.split("\r\n").filter((l) => l.startsWith("."))).toEqual([]);
    expect(Buffer.from(m.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString()).toBe(".hidden line\r\nsecond");
  });
});
