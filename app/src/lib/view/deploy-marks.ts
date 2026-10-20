import { clock } from "@/lib/time";
import { shortSha } from "./format";
import { wibDay } from "./uptime";

// A1: production deploys on the app's charts, so "did the deploy cause it?" is answered at a glance. Ticks sit on the
// 24 h response chart (48 half-hour points); day marks sit on the 90-day bars (WIB days). Deployments are kept
// 30 days (plus the current and previous production ones), so older bars have no marks.
export type DeployMark = { at: Date; sha: string | null; state: string };

const verb = (state: string) => (state === "error" ? "Deploy failed" : state === "building" ? "Deploying" : "Deployed");

export function deployTicks(deps: DeployMark[], first: number, sizeMs: number, n: number, width: number): { x: number; title: string }[] {
  const end = first + n * sizeMs;
  return deps
    .filter((d) => d.at.getTime() >= first && d.at.getTime() < end)
    .map((d) => {
      const idx = Math.min((d.at.getTime() - first) / sizeMs, n - 1);
      return { x: Math.round((idx / Math.max(1, n - 1)) * width * 10) / 10, title: `${verb(d.state)} ${shortSha(d.sha)} · ${clock(d.at)}` };
    });
}

export function deployDays(deps: DeployMark[]): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const d of [...deps].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const k = wibDay(d.at);
    const label = `${shortSha(d.sha)}${d.state === "error" ? " (failed)" : ""}`;
    out.set(k, [...(out.get(k) ?? []), label]);
  }
  return new Map([...out].map(([k, v]) => [k, v.join(", ")]));
}
