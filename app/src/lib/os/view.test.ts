import { describe, expect, it } from "vitest";
import type { KernelState, OsUpdate } from "./scan";
import { DEMO_OS_SCAN } from "./demo";
import { fixAllCommand, fixCommand, kernelAdvice, osFact, scoreSeverity, splitUpdates } from "./view";

const upd = (over: Partial<OsUpdate> = {}): OsUpdate => ({
  source: "gst-plugins-base1.0", binaries: ["gstreamer1.0-gl", "gstreamer1.0-plugins-base"], installed: "1.20.1-1ubuntu0.7", candidate: "1.20.1-1ubuntu0.8",
  pockets: ["jammy-updates", "jammy-security"], security: true,
  fixes: [{ cve: "CVE-2026-111183", priority: "medium", cvss3: 9.8, status: "released", version: "1.20.1-1ubuntu0.8", usns: ["USN-9038-1"], summary: "x" }], error: null, ...over,
});
const kernel = (over: Partial<KernelState> = {}): KernelState => ({
  running: "5.15.0-202-generic", runningVersion: "5.15.0-202.212", newestInstalled: "5.15.0-203.213", reboot: { needed: true, packages: ["linux-image-5.15.0-203-generic"] }, update: null, ...over,
});

describe("OS page helpers", () => {
  it("fix commands upgrade only the named packages, never everything", () => {
    expect(fixCommand(upd())).toBe("sudo apt update && sudo apt install --only-upgrade gstreamer1.0-gl gstreamer1.0-plugins-base");
    expect(fixAllCommand([upd(), upd({ source: "gst-plugins-good1.0", binaries: ["gstreamer1.0-plugins-good", "gstreamer1.0-gl"] })]))
      .toBe("sudo apt update && sudo apt install --only-upgrade gstreamer1.0-gl gstreamer1.0-plugins-base gstreamer1.0-plugins-good");
    expect(fixAllCommand([])).toBeNull();
  });
  it("security updates are the ones from the security pocket or with a CVE fix; the rest are other updates", () => {
    const { security, other } = splitUpdates([upd(), upd({ source: "docker-ce", security: false, fixes: [], pockets: ["jammy"] }), upd({ source: "glib2.0", security: false })]);
    expect(security.map((u) => u.source)).toEqual(["gst-plugins-base1.0", "glib2.0"]);
    expect(other.map((u) => u.source)).toEqual(["docker-ce"]);
    expect(splitUpdates([upd({ security: false, fixes: [], error: "Ubuntu's security API answered HTTP 503." })]).security).toHaveLength(1); // review M4
  });
  it("turns a scan into the alert's facts: security updates by worst score, and a kernel waiting for a reboot", () => {
    expect(osFact(DEMO_OS_SCAN)).toEqual({ system: "Ubuntu 22.04.5 LTS", updates: [{ source: "gst-plugins-base1.0", score: 9.8, cves: ["CVE-2026-111183"] }, { source: "gst-plugins-good1.0", score: 9.8, cves: ["CVE-2026-111183", "CVE-2026-46471"] }], kernelWaiting: { installed: "5.15.0-201.211", running: "5.15.0-199.209" }, partial: false });
    expect(osFact(null)).toBeNull();
    expect(osFact({ ...DEMO_OS_SCAN, status: "unsupported" })).toBeNull();
    // review I2: a lookup that failed marks the facts partial (fire on what is known, never resolve); the rest still counts
    const partial = osFact({ ...DEMO_OS_SCAN, updates: [DEMO_OS_SCAN.updates[0], { ...DEMO_OS_SCAN.updates[3], fixes: [], error: "Ubuntu's security API didn't answer in time." }] });
    expect(partial).toMatchObject({ partial: true, updates: [{ source: "gst-plugins-base1.0", score: 9.8 }] });
    expect(osFact(DEMO_OS_SCAN)?.partial).toBe(false);
  });
  it("names the score's severity the CVSS way", () => {
    expect([9.8, 7.5, 5.5, 2.1, null].map(scoreSeverity)).toEqual(["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]);
  });
  it("kernel: a newer one installed but not running asks for a reboot", () => {
    expect(kernelAdvice(kernel())).toEqual({ state: "warn", text: "Kernel 5.15.0-203.213 is installed, but 5.15.0-202.212 is still running. Reboot to run it.", command: "sudo reboot" });
  });
  it("kernel: an update waiting in apt says to install it, then reboot", () => {
    expect(kernelAdvice(kernel({ newestInstalled: "5.15.0-202.212", reboot: { needed: false, packages: [] }, update: { package: "linux-image-generic", candidate: "5.15.0.204.176" } })))
      .toEqual({ state: "warn", text: "A kernel update is waiting (linux-image-generic 5.15.0.204.176). Install it, then reboot.", command: "sudo apt update && sudo apt full-upgrade" });
  });
  it("kernel: one that isn't from an Ubuntu package (WSL, a container) says the host updates it (review M5)", () => {
    expect(kernelAdvice(kernel({ running: "6.6.87.2-microsoft-standard-WSL2", runningVersion: null, newestInstalled: null, reboot: { needed: false, packages: [] } })))
      .toEqual({ state: "ok", text: "The running kernel (6.6.87.2-microsoft-standard-WSL2) isn't from an Ubuntu package: the host it runs on updates it.", command: null });
  });
  it("kernel: up to date says so; another reboot reason is named", () => {
    expect(kernelAdvice(kernel({ newestInstalled: "5.15.0-202.212", reboot: { needed: false, packages: [] } }))).toEqual({ state: "ok", text: "The newest installed kernel is running.", command: null });
    expect(kernelAdvice(kernel({ newestInstalled: "5.15.0-202.212", reboot: { needed: true, packages: ["libc6"] } })))
      .toEqual({ state: "warn", text: "An update waits for a reboot (libc6).", command: "sudo reboot" });
  });
});
