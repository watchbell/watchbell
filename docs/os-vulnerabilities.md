# OS vulnerabilities

Bahasa Indonesia: [id/os-vulnerabilities.md](id/os-vulnerabilities.md)

DevOps › Security › **OS vulnerabilities** shows the known vulnerabilities on the machine a self-hosted Watchbell runs
on, each with its score, how to fix it and links to the vendor and the community. Ubuntu for now; Debian is next. The
cloud edition can't see a machine, so the page is part of the self-hosted edition only.

## What it checks

- **The kernel.** Which kernel runs, the newest one installed, and a kernel update waiting in apt. When a newer kernel
  is installed but not running, the page says to reboot. Ubuntu tracks thousands of kernel CVEs; running the newest
  kernel it ships is how they get fixed, so they aren't listed one by one. The card links Ubuntu's kernel notices.
- **Security updates waiting.** Every package with an update in apt from Ubuntu's own repositories. For each one,
  Ubuntu's security data says which CVEs the update fixes: the CVE, its CVSS score (0–10), Ubuntu's priority, and links to Ubuntu's CVE page, the
  Ubuntu Security Notice (USN) and NVD. A command to copy upgrades just those packages; another upgrades them all.
- **Other updates.** Updates that aren't security fixes (bug fixes, other repositories), folded away.
- **No fix yet.** How many advisories OSV.dev lists for the installed packages without a fix it knows of, per package,
  folded away. Packages with an update waiting are left out, since the update may fix them. Most are low priority, deferred, or in universe packages Ubuntu doesn't support. OSV can lag Ubuntu, so
  each package links Ubuntu's tracker for the current status.

## How it works

Watchbell runs two read-only commands on the machine, `dpkg-query` (installed packages) and `apt list --upgradable`
(updates waiting), and reads `/etc/os-release`, the running kernel and `/var/run/reboot-required`. It then asks
Ubuntu's security API (ubuntu.com/security) about the packages with an update, and OSV.dev about the other installed
packages (the kernel aside). Only
package names and versions leave the machine.

Watchbell never installs, upgrades or reboots anything. The commands on the page are there for you to copy and run.

The daily job scans the machine; the owner can press **Scan now** (it takes up to a minute). If apt's package lists
are more than two days old, the page says so: run `sudo apt update`, or updates may be missing. A scan that fails
keeps the last good results and says when and why it failed.

## The alert

**OsSecurityUpdate** (warning, DevOps section) fires while a waiting security update fixes a CVE scored 7.0 or more,
or a newer kernel waits for a reboot. A score of 9.0 or more makes it critical. Change the score on Manage › Alerts
(whole numbers; 0 alerts on every scored fix). When an update's fixes couldn't be read, the alert still fires on the
fixes that were read, but doesn't resolve until a scan reads them all. It resolves after you install the updates, reboot if needed, and the next scan runs.

## Who sees it

Operators and owners; Scan now is the owner's. In the demo the page shows a made-up machine with real public CVE
records, and Scan now is off.
