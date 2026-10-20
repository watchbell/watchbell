import { describe, expect, it } from "vitest";
import { blockedHostname, isBlockedAddress, localProviderHost, urlProblem } from "./public-host";

describe("isBlockedAddress: IPv4", () => {
  it.each([
    "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.19.255.255",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.0.0.0", "192.0.0.8", "192.0.0.170", "192.0.0.255",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    "1.1.1.1", "8.8.8.8", "76.76.21.21", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "169.253.0.1", "169.255.0.1",
    "192.167.0.1", "192.169.0.1", "198.17.255.255", "198.20.0.1", "11.0.0.1", "126.255.255.255", "128.0.0.1", "223.255.255.255",
    "191.255.255.255", "192.0.1.0", "192.0.2.1", "192.1.0.0",
  ])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe("isBlockedAddress: IPv6", () => {
  it.each([
    "::", "::1", "fc00::1", "fd12:3456::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:192.168.1.1",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:a9fe:a9fe::", "0:0:0:0:0:0:0:1",
    "::ffff:0:0", "::ffff:100.64.0.1", "FE80::ABCD",
    // Task 6 N2: every form that carries an IPv4 address, whichever IPv4 address it carries.
    "::ffff:8.8.8.8", "::ffff:808:808", "::FFFF:8.8.8.8", "0:0:0:0:0:ffff:808:808", "0::ffff:8.8.8.8", "0000:0000:0000:0000:0000:ffff:0808:0808",
    "::ffff:0:8.8.8.8", "::ffff:0:808:808", "0:0:0:0:ffff:0:808:808", "::ffff:0:127.0.0.1", "::ffff:0:7f00:1",
    "64:ff9b::808:808", "64:ff9b::8.8.8.8", "64:ff9b:0:0:0:0:808:808", "64:ff9b::7f00:1",
    "64:ff9b:1::1", "64:ff9b:1::808:808", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "64:ff9b:1:abcd::8.8.8.8",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::200e",
    "2002:808:808::1", "fb00::1", "fe00::1", "2001:db8::1", "64:ff9a::808:808",
  ])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("fails closed: text it can't parse as an address is blocked (final review M10)", () => {
    for (const odd of ["example.com", "", "1.2.3", "256.0.0.1", "1.2.3.4.5", "::1::2", "fe80::1::", "12345::1", "0x7f.0.0.1", " 8.8.8.8", "::ffff:8.8.8"]) {
      expect(isBlockedAddress(odd), odd).toBe(true);
    }
  });
});

describe("blockedHostname", () => {
  it.each([
    "localhost", "LOCALHOST", "localhost.", "app.localhost", "printer.local", "db.internal", "x.y.internal", "router.home.arpa",
    "intranet", "[::1]", "[fc00::1]", "[fe80::1]", "[::ffff:7f00:1]", "127.0.0.1", "10.1.2.3", "169.254.169.254", "0x7f.1", "2130706433", "0177.0.0.1", "1.2.3", "300.1.1.1",
  ])("blocks %s", (host) => expect(blockedHostname(host)).toBe(true));

  it.each(["example.com", "ops.example.web.id", "xn--80ak6aa92e.com", "a.b.example.co.id", "8.8.8.8", "[2606:4700:4700::1111]", "localhost.example.com", "internal.example.com", "mylocal.dev"])(
    "allows %s",
    (host) => expect(blockedHostname(host)).toBe(false),
  );
});

describe("urlProblem", () => {
  const p = (u: string) => urlProblem(new URL(u));
  it("accepts a public https address on the default port", () => {
    expect(p("https://example.com/api/health")).toBeNull();
    expect(p("https://example.com:443/")).toBeNull();
    expect(p("https://8.8.8.8/")).toBeNull();
  });
  it("is https only, without userinfo", () => {
    expect(p("http://example.com/")).toBe("scheme");
    expect(p("ftp://example.com/")).toBe("scheme");
    expect(p("https://user:pw@example.com/")).toBe("scheme");
    expect(p("https://user@example.com/")).toBe("scheme");
  });
  it("refuses private hosts and any port other than 443", () => {
    expect(p("https://127.0.0.1/")).toBe("blocked");
    expect(p("https://0x7f.1/")).toBe("blocked");
    expect(p("https://2130706433/")).toBe("blocked");
    expect(p("https://localhost/")).toBe("blocked");
    expect(p("https://[::1]/")).toBe("blocked");
    expect(p("https://[::ffff:127.0.0.1]/")).toBe("blocked");
    expect(p("https://169.254.169.254/latest/meta-data")).toBe("blocked");
    expect(p("https://example.com:8443/")).toBe("blocked");
    expect(p("https://example.com:80/")).toBe("blocked");
  });
  it("refuses IPv4-carrying IPv6 literals and 192.0.0.0/24 in a URL too (task 6 N2)", () => {
    for (const u of ["https://[::ffff:8.8.8.8]/", "https://[::ffff:0:8.8.8.8]/", "https://[64:ff9b::8.8.8.8]/", "https://[64:ff9b:1::1]/", "https://192.0.0.170/"]) {
      expect(p(u), u).toBe("blocked");
    }
  });
});

// Ruling Q11: only a self-hosted AI provider's base URL uses this; every other guard above is unchanged.
describe("localProviderHost", () => {
  it("names loopback, private LAN and metadata hosts; null for anything else", () => {
    const cases: [string, ReturnType<typeof localProviderHost>][] = [
      ["localhost", "loopback"], ["LOCALHOST.", "loopback"], ["127.0.0.1", "loopback"], ["127.9.9.9", "loopback"], ["[::1]", "loopback"],
      ["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.5", "private"], ["[fd12:3456::1]", "private"], ["[fc00::1]", "private"], ["ollama.local", "private"],
      ["169.254.169.254", "metadata"], ["169.254.0.1", "metadata"], ["[fe80::1]", "metadata"], ["[febf::1]", "metadata"], ["metadata.google.internal", "metadata"], ["[fd00:ec2::254]", "metadata"],
      ["172.15.0.1", null], ["172.32.0.1", null], ["100.64.0.1", null], ["0.0.0.0", null], ["224.0.0.1", null], ["[::ffff:127.0.0.1]", null], ["example.com", null], ["ollama", null], [".local", null], ["[nope]", null],
    ];
    for (const [h, want] of cases) expect(localProviderHost(h), h).toBe(want);
  });
  it("leaves the public rules as they were: those hosts stay blocked for monitors and every other fetch", () => {
    for (const h of ["localhost", "192.168.1.5", "169.254.169.254", "[::1]", "ollama.local"]) expect(blockedHostname(h), h).toBe(true);
    expect(urlProblem(new URL("http://localhost:11434/v1"))).toBe("scheme");
    expect(urlProblem(new URL("https://192.168.1.5/v1"))).toBe("blocked");
  });
});
