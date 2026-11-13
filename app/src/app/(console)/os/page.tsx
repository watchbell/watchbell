import { IconShieldCheck } from "@tabler/icons-react";
import { Card, EmptyState, PageHeader } from "@/components/kit";
import { requirePageMember } from "@/lib/auth";
import { loadOsScan, OFF_CLOUD, osState, type StoredScan } from "@/lib/data/os-scan-db";
import { DEMO_OS_SCAN } from "@/lib/os/demo";
import { OsView } from "./os-view";

// DevOps › Security › OS vulnerabilities (owner 12 Nov): known vulnerabilities on the machine a self-hosted Watchbell
// runs on (Ubuntu for now), from apt, Ubuntu's security data and OSV.dev. The daily job scans; the owner can scan now.
export default async function OsPage() {
  const member = await requirePageMember();
  const state = osState();
  let blocked: string | null = null;
  let scan: StoredScan | null = null;
  if (member.role === "viewer") blocked = "OS vulnerabilities are for operators and owners.";
  else if (state === "off-cloud") blocked = OFF_CLOUD;
  else if (state === "demo") scan = DEMO_OS_SCAN;
  else scan = await loadOsScan();
  return (
    <>
      <PageHeader
        crumbs={[{ label: "DevOps" }, { label: "OS vulnerabilities" }]}
        title="OS vulnerabilities"
        sub="Known vulnerabilities on the machine Watchbell runs on, with each one's score and how to fix it. Read-only: Watchbell never installs or upgrades anything."
        more="Watchbell reads the installed packages (dpkg-query) and the updates waiting (apt list --upgradable), asks Ubuntu's security API which CVEs those updates fix, and asks OSV.dev how many advisories have no fix yet. Only package names and versions leave the machine. The daily job scans; the owner can scan now."
      />
      {blocked ? (
        <Card flush><EmptyState icon={IconShieldCheck} title="OS vulnerabilities can't be shown">{blocked}</EmptyState></Card>
      ) : (
        <OsView initial={scan} owner={member.role === "owner"} demo={state === "demo"} />
      )}
    </>
  );
}
