import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_URL, fetchBootstrap, lookupDomain, parseRdapDomain, rdapBase, type Services } from "./rdap";

const catchAll = http.all("*", ({ request }) => {
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
});
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const use = (...h: Parameters<typeof server.use>) => server.use(...h, catchAll);

// Shape of the real answer for example.web.id on 12 Oct 2026 (rdap.pandi.id), personal data left out.
const pandi = {
  objectClassName: "domain", ldhName: "EXAMPLE.WEB.ID", status: ["client transfer prohibited"],
  events: [
    { eventAction: "registration", eventDate: "2026-06-24T12:52:06Z" },
    { eventAction: "expiration", eventDate: "2027-06-24T23:59:59Z" },
    { eventAction: "last update of RDAP database", eventDate: "2026-10-12T14:20:29Z" },
  ],
  entities: [{ objectClassName: "entity", roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "PT JC Indonesia"]]] }],
};
// Every request goes through the monitors' guard, which resolves the host first: a stub keeps the tests off the network.
const pub = { lookup: async () => ["93.184.216.34"] };
const services: Services = [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]], [["id"], ["http://rdap.pandi.id/rdap/", "https://rdap.pandi.id/rdap/"]]];

describe("rdapBase", () => {
  it("finds the TLD's server and prefers https", () => {
    expect(rdapBase(services, "example.web.id")).toBe("https://rdap.pandi.id/rdap/");
    expect(rdapBase(services, "Example.COM.")).toBe("https://rdap.verisign.com/com/v1/");
  });
  it("is null for a TLD with no RDAP server or with only http", () => {
    expect(rdapBase(services, "example.xyz")).toBeNull();
    expect(rdapBase([[["io"], ["http://rdap.example/"]]], "a.io")).toBeNull();
  });
  it("I2: only an https URL on a public host is taken; the next entry is tried", () => {
    const base = (urls: string[]) => rdapBase([[["io"], urls]], "a.io");
    expect(base(["https://10.0.0.5/rdap/"])).toBeNull();
    expect(base(["https://169.254.169.254/latest/"])).toBeNull();
    expect(base(["https://93.184.216.34/rdap/"])).toBeNull(); // a registry has a name, never a bare address
    expect(base(["https://[::1]/rdap/"])).toBeNull();
    expect(base(["https://localhost/rdap/"])).toBeNull();
    expect(base(["https://rdap.internal/"])).toBeNull();
    expect(base(["https://intranet/rdap/"])).toBeNull();
    expect(base(["https://user:pw@rdap.example.io/"])).toBeNull();
    expect(base(["https://rdap.example.io:8443/"])).toBeNull();
    expect(base(["not a url", "https://10.0.0.5/", "https://rdap.example.io/v1/"])).toBe("https://rdap.example.io/v1/");
  });
});

describe("parseRdapDomain", () => {
  it("reads the expiration event and the registrar's name", () => {
    expect(parseRdapDomain(pandi)).toEqual({ expiresAt: "2027-06-24T23:59:59.000Z", registrar: "PT JC Indonesia" });
  });
  it("no expiration event is null, not a guess", () => {
    expect(parseRdapDomain({ ...pandi, events: [] })).toEqual({ expiresAt: null, registrar: "PT JC Indonesia" });
  });
  it("anything that isn't a domain object is null", () => {
    expect(parseRdapDomain({ errorCode: 404 })).toBeNull();
    expect(parseRdapDomain("nope")).toBeNull();
  });
});

describe("fetchBootstrap and lookupDomain", () => {
  it("reads IANA's bootstrap", async () => {
    use(http.get(BOOTSTRAP_URL, () => HttpResponse.json({ version: "1.0", publication: "2026-09-30T23:00:03Z", services })));
    expect(await fetchBootstrap(pub)).toEqual({ ok: true, services });
  });
  it("GETs {base}domain/{name} with the RDAP media type", async () => {
    use(http.get("https://rdap.pandi.id/rdap/domain/example.web.id", ({ request }) => {
      expect(request.headers.get("accept")).toContain("application/rdap+json");
      return HttpResponse.json(pandi);
    }));
    expect(await lookupDomain("example.web.id", "https://rdap.pandi.id/rdap/", pub)).toEqual({ ok: true, expiresAt: "2027-06-24T23:59:59.000Z", registrar: "PT JC Indonesia" });
  });
  it("404 and 5xx and junk are errors with a reason", async () => {
    use(http.get("https://rdap.pandi.id/rdap/domain/gone.web.id", () => new HttpResponse(null, { status: 404 })));
    expect(await lookupDomain("gone.web.id", "https://rdap.pandi.id/rdap/", pub)).toEqual({ ok: false, error: "The registry doesn't know this domain" });
    server.resetHandlers();
    use(http.get("https://rdap.pandi.id/rdap/domain/example.web.id", () => new HttpResponse(null, { status: 503 })));
    expect(await lookupDomain("example.web.id", "https://rdap.pandi.id/rdap/", pub)).toEqual({ ok: false, error: "The registry's RDAP server returned an error (503)" });
    server.resetHandlers();
    use(http.get("https://rdap.pandi.id/rdap/domain/example.web.id", () => HttpResponse.json({ hello: 1 })));
    expect(await lookupDomain("example.web.id", "https://rdap.pandi.id/rdap/", pub)).toEqual({ ok: false, error: "The registry answered in a format the console doesn't recognise" });
  });
});

describe("lookupDomain is SSRF-safe (stage 4 review I2)", () => {
  const refused = { ok: false, error: "The registry's RDAP address isn't a public https address" };
  it("never fetches a private, plain-http or unresolvable-as-public base", async () => {
    use(); // the catch-all fails the test if anything is requested
    expect(await lookupDomain("a.io", "https://10.0.0.5/rdap/", pub)).toEqual(refused);
    expect(await lookupDomain("a.io", "http://rdap.example.io/", pub)).toEqual(refused);
    expect(await lookupDomain("a.io", "https://rdap.example.io/", { lookup: async () => ["10.1.2.3"] })).toEqual(refused);
    expect(await lookupDomain("a.io", "https://rdap.example.io/", { lookup: async () => ["93.184.216.34", "127.0.0.1"] })).toEqual(refused);
  });
  it("a redirect to the metadata address, plain http or a private name is not followed", async () => {
    for (const to of ["http://169.254.169.254/latest/meta-data/", "https://169.254.169.254/", "https://rdap.internal/x", "http://rdap.example.io/domain/a.io"]) {
      server.resetHandlers();
      use(http.get("https://rdap.example.io/domain/a.io", () => new HttpResponse(null, { status: 302, headers: { location: to } })));
      expect(await lookupDomain("a.io", "https://rdap.example.io/", pub)).toEqual(refused);
    }
  });
  it("a redirect to a public host whose name resolves to a private address is not followed", async () => {
    use(http.get("https://rdap.example.io/domain/a.io", () => new HttpResponse(null, { status: 301, headers: { location: "https://rebind.example.org/domain/a.io" } })));
    const lookup = async (h: string) => (h === "rebind.example.org" ? ["10.9.9.9"] : ["93.184.216.34"]);
    expect(await lookupDomain("a.io", "https://rdap.example.io/", { lookup })).toEqual(refused);
  });
  it("a redirect to another public https host is followed and checked again", async () => {
    use(
      http.get("https://rdap.example.io/domain/example.web.id", () => new HttpResponse(null, { status: 302, headers: { location: "https://rdap2.example.net/domain/example.web.id" } })),
      http.get("https://rdap2.example.net/domain/example.web.id", () => HttpResponse.json(pandi)),
    );
    expect(await lookupDomain("example.web.id", "https://rdap.example.io/", pub)).toEqual({ ok: true, expiresAt: "2027-06-24T23:59:59.000Z", registrar: "PT JC Indonesia" });
  });
  it("the bootstrap is read through the same guard", async () => {
    use(http.get(BOOTSTRAP_URL, () => new HttpResponse(null, { status: 302, headers: { location: "http://169.254.169.254/" } })));
    expect(await fetchBootstrap(pub)).toEqual({ ok: false, error: "Couldn't read IANA's RDAP list" });
  });
});
