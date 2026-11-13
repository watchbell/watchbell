import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ecosystemFor, parseDpkg, parseOsRelease, parseReboot, sourcesToCheck } from "./host";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const jammy = parseOsRelease(fixture("jammy-os-release.txt"))!;
const pkgs = parseDpkg(fixture("jammy-dpkg.txt"));

describe("parseOsRelease / ecosystemFor", () => {
  it("reads the VM's Ubuntu 22.04 LTS and names its OSV ecosystem", () => {
    expect(jammy).toMatchObject({ id: "ubuntu", versionId: "22.04", codename: "jammy", pretty: "Ubuntu 22.04.5 LTS", lts: true });
    expect(ecosystemFor(jammy)).toBe("Ubuntu:22.04:LTS");
  });
  it("names a non-LTS Ubuntu and Debian by major version", () => {
    expect(ecosystemFor(parseOsRelease('ID=ubuntu\nVERSION_ID="24.10"\nVERSION="24.10 (Oracular Oriole)"\n')!)).toBe("Ubuntu:24.10");
    expect(ecosystemFor(parseOsRelease('ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n')!)).toBe("Debian:12");
  });
  it("has no ecosystem for systems it doesn't check, and no release for junk", () => {
    expect(ecosystemFor(parseOsRelease('ID=fedora\nVERSION_ID=41\n')!)).toBeNull();
    expect(ecosystemFor(parseOsRelease('ID=debian\nPRETTY_NAME="Debian sid"\n')!)).toBeNull();
    expect(parseOsRelease("")).toBeNull();
    expect(parseOsRelease("nonsense")).toBeNull();
  });
});

describe("parseDpkg", () => {
  it("reads name, version, source and source version, and marks only installed packages", () => {
    expect(pkgs.find((p) => p.name === "libssl3")).toEqual({ name: "libssl3", version: "3.0.2-0ubuntu1.30", source: "openssl", sourceVersion: "3.0.2-0ubuntu1.30", installed: true });
    expect(pkgs.find((p) => p.name === "linux-image-5.15.0-181-generic")?.installed).toBe(false); // rc: removed, config left
  });
  it("skips lines it can't read", () => {
    expect(parseDpkg("broken\n\tno-name\t1\t\t\nok\t1.0\t\t\tii \n")).toEqual([{ name: "ok", version: "1.0", source: "ok", sourceVersion: "1.0", installed: true }]);
  });
});

describe("sourcesToCheck", () => {
  const sources = sourcesToCheck(pkgs, "5.15.0-202-generic");
  const byName = (n: string) => sources.filter((s) => s.name === n);
  it("groups binaries under their source package, once per installed version", () => {
    expect(byName("openssl")).toEqual([{ name: "openssl", version: "3.0.2-0ubuntu1.30", binaries: ["libssl3", "openssl"], kernel: false }]);
    expect(byName("glibc")[0].binaries).toEqual(["libc-bin", "libc6", "libc6-dev", "libc6-i386"]);
  });
  it("checks the running kernel only, under OSV's name for it (linux-signed → linux), and skips linux-meta", () => {
    expect(byName("linux")).toEqual([{ name: "linux", version: "5.15.0-202.212", binaries: expect.arrayContaining(["linux-image-5.15.0-202-generic", "linux-modules-5.15.0-202-generic"]), kernel: true }]);
    expect(byName("linux-signed")).toEqual([]);
    expect(byName("linux-meta")).toEqual([]);
    expect(byName("linux")[0].binaries).not.toContain("linux-image-5.15.0-181-generic");
  });
  it("keeps the other kernel-related sources that aren't the kernel itself", () => {
    expect(byName("linux-base")).toHaveLength(1);
  });
  it("without the running kernel's package, checks every installed kernel version", () => {
    expect(sourcesToCheck(pkgs, null).filter((s) => s.name === "linux").map((s) => s.version).sort()).toEqual(["5.15.0-202.212", "5.15.0-203.213"]);
  });
});

describe("parseReboot", () => {
  it("a pending reboot names the packages that asked for it", () => {
    expect(parseReboot("*** System restart required ***\n", fixture("jammy-reboot-required.pkgs"))).toEqual({ needed: true, packages: ["linux-image-5.15.0-203-generic", "linux-base"] });
  });
  it("no flag file: no reboot needed", () => {
    expect(parseReboot(null, null)).toEqual({ needed: false, packages: [] });
  });
});
