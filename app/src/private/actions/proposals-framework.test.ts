import { describe, expect, it } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { factNeeds, type ProposalAlert, type ProposalFacts, proposalsFor } from "./proposals";

// Watchbell 1.2 (owner 23 Oct): the Security card's Next.js check fires FrameworkVulnerable, which proposes the same
// "Open package update PR" action as VulnerableDependency, updating next to the version that clears the advisories.
const now = new Date("2026-10-23T03:00:00Z");
const APP = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const alert = (o: Partial<ProposalAlert> = {}): ProposalAlert => ({
  id: "44444444-4444-4444-8444-444444444444", ruleKey: "FrameworkVulnerable", subject: APP, severity: "critical", title: "shopfront",
  message: "Next.js 16.3.8 has 2 known vulnerabilities (critical), fixed in 16.4.1.", resourceId: APP, resourceKind: "app", resourceName: "shopfront", causedBy: null,
  silencedUntil: null, silencedUntilResolved: false, ...o,
});
const facts = (fixes: ProposalFacts["frameworkFixes"]): ProposalFacts => ({ monitorKinds: new Map(), deploys: new Map(), supabaseRefs: new Map(), neonSuspended: new Map(), frameworkFixes: fixes });
const fix = new Map([[APP, { repoId: REPO, from: "16.3.8", to: "16.4.1" }]]);

describe("FrameworkVulnerable → github_bump_pr (Watchbell 1.2)", () => {
  it("proposes a risky update PR on the app's linked repository, naming Next.js and the target version", () => {
    const [p, ...rest] = proposalsFor(alert(), facts(fix), EMPTY_BOOK, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      ruleKey: "FrameworkVulnerable", action: "github_bump_pr", risk: "risky", room: "workloads", resourceKind: "app", resourceId: APP, targetRef: REPO,
      proposedBy: ACTIONS_COPY.proposedBy("Workloads"),
    });
    expect(p.title).toMatch(/^Open a PR updating Next\.js in /);
    expect(p.reason).toMatch(/^Next\.js 16\.3\.8 in .+ has known vulnerabilities: the PR updates next \(and eslint-config-next when listed\) to 16\.4\.1\.$/);
    expect(p.reason.length).toBeLessThanOrEqual(200);
  });

  it("nothing without a linked repository with a fix, for a silenced alert, or for an alert not on an app", () => {
    expect(proposalsFor(alert(), facts(new Map()), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert(), facts(undefined), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert({ silencedUntilResolved: true }), facts(fix), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert({ resourceKind: null }), facts(fix), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert(), facts(new Map([[APP, { repoId: "not-a-uuid", from: "16.3.8", to: "16.4.1" }]])), EMPTY_BOOK, now)).toEqual([]);
  });

  it("asks the database layer for these apps, next to the VulnerableDependency ones", () => {
    const need = factNeeds([alert(), alert({ id: "55555555-5555-4555-8555-555555555555", ruleKey: "VulnerableDependency" })], now);
    expect(need.frameworkApps).toEqual([APP]);
    expect(need.depApps).toEqual([APP]);
    expect(factNeeds([alert({ silencedUntilResolved: true })], now).frameworkApps).toEqual([]);
  });

  it("VulnerableDependency's proposal is unchanged", () => {
    const [p] = proposalsFor(alert({ ruleKey: "VulnerableDependency", message: "1 vulnerable package (1 critical): next 15.0.0 → 15.2.3." }),
      { ...facts(fix), fixableRepos: new Map([[APP, REPO]]) }, EMPTY_BOOK, now);
    expect(p.title).toMatch(/^Open a PR updating vulnerable packages in /);
    expect(p.reason).toMatch(/^Vulnerable packages in .+ have a fix: next 15\.0\.0 → 15\.2\.3\.$/);
  });
});
