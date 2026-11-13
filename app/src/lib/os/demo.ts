import type { OsScan } from "./scan";

// The demo's machine: made-up (no real machine's versions or counts), shaped like a real Ubuntu scan. The CVE records
// (ids, scores, notices and the first sentence of each description) are copied from Ubuntu's public security data,
// never invented.
export const DEMO_OS_SCAN: OsScan = {
  status: "ok",
  system: "Ubuntu 22.04.5 LTS",
  ecosystem: "Ubuntu:22.04:LTS",
  codename: "jammy",
  packages: 1312,
  kernel: {
    running: "5.15.0-199-generic", runningVersion: "5.15.0-199.209", newestInstalled: "5.15.0-201.211",
    reboot: { needed: true, packages: ["linux-image-5.15.0-201-generic"] }, update: null,
  },
  updates: [
    {
      source: "gst-plugins-base1.0", binaries: ["gstreamer1.0-gl", "gstreamer1.0-plugins-base", "libgstreamer-plugins-base1.0-0"],
      installed: "1.20.1-1ubuntu0.7", candidate: "1.20.1-1ubuntu0.8", pockets: ["jammy-updates", "jammy-security"], security: true, error: null,
      fixes: [{ cve: "CVE-2026-111183", priority: "medium", cvss3: 9.8, status: "released", version: "1.20.1-1ubuntu0.8", usns: ["USN-9038-1"], summary: "GStreamer rtpL16depay Heap-based Buffer Overflow Remote Code Execution Vulnerability." }],
    },
    {
      source: "gst-plugins-good1.0", binaries: ["gstreamer1.0-plugins-good", "libgstreamer-plugins-good1.0-0"],
      installed: "1.20.3-0ubuntu1.10", candidate: "1.20.3-0ubuntu1.11", pockets: ["jammy-updates", "jammy-security"], security: true, error: null,
      fixes: [
        { cve: "CVE-2026-111183", priority: "medium", cvss3: 9.8, status: "released", version: "1.20.3-0ubuntu1.11", usns: ["USN-9038-1"], summary: "GStreamer rtpL16depay Heap-based Buffer Overflow Remote Code Execution Vulnerability." },
        { cve: "CVE-2026-46471", priority: "medium", cvss3: 5.5, status: "released", version: "1.20.3-0ubuntu1.11", usns: ["USN-9038-1"], summary: "An issue was discovered in GStreamer gst-plugins-good before 1.28.2." },
      ],
    },
    { source: "docker-ce", binaries: ["docker-ce", "docker-ce-cli"], installed: "5:28.5.1-1~ubuntu.22.04~jammy", candidate: "5:28.5.2-1~ubuntu.22.04~jammy", pockets: ["jammy"], security: false, fixes: [], error: null },
    { source: "glib2.0", binaries: ["libglib2.0-0", "libglib2.0-bin"], installed: "2.72.4-0ubuntu2.8", candidate: "2.72.4-0ubuntu2.9", pockets: ["jammy-updates"], security: false, fixes: [], error: null },
  ],
  backlog: { counts: { "mariadb-10.6": 118, webkit2gtk: 74, qemu: 52, binutils: 31, "bind9-libs": 22, imagemagick: 19 }, total: 316, error: null },
  aptListsAgeHours: 5,
  scannedAt: "2026-11-11T02:00:00.000Z",
  error: null,
};
