import { describe, expect, it } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";
import { EMPTY_BOOK } from "@/lib/view/display-name";
import { factNeeds, type ProposalAlert, type ProposalFacts, proposalsFor } from "./proposals";
import { ACTIONS } from "./proposals-types";

const now = new Date("2026-10-16T03:00:00Z");
const APP = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const alert = (o: Partial<ProposalAlert> = {}): ProposalAlert => ({
  id: "44444444-4444-4444-8444-444444444444", ruleKey: "VulnerableDependency", subject: APP, severity: "critical", title: "acme-shop",
  message: "1 vulnerable package (1 critical): next 15.0.0 → 15.2.3.", resourceId: APP, resourceKind: "app", resourceName: "acme-shop", causedBy: null,
  silencedUntil: null, silencedUntilResolved: false, ...o,
});
const facts = (fixable: Map<string, string>): ProposalFacts => ({ monitorKinds: new Map(), deploys: new Map(), supabaseRefs: new Map(), neonSuspended: new Map(), fixableRepos: fixable });

describe("VulnerableDependency → github_bump_pr (Stage 9 slice 5)", () => {
  it("is risky (never auto-run) and labelled for the owner", () => {
    expect(ACTIONS.github_bump_pr).toMatchObject({ risk: "risky", label: "Open package update PR" });
  });

  it("proposes an update PR when the app's repository has a fixable direct package; the target is the repository", () => {
    const [p, ...rest] = proposalsFor(alert(), facts(new Map([[APP, REPO]])), EMPTY_BOOK, now);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ action: "github_bump_pr", risk: "risky", room: "workloads", resourceKind: "app", resourceId: APP, targetRef: REPO, proposedBy: ACTIONS_COPY.proposedBy("Workloads") });
    expect(p.title).toMatch(/^Open a PR updating vulnerable packages in /);
    expect(p.reason).toMatch(/^Vulnerable packages in /);
  });

  it("nothing without a known fix, for a silenced alert, or for an alert not on an app", () => {
    expect(proposalsFor(alert(), facts(new Map()), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert({ silencedUntilResolved: true }), facts(new Map([[APP, REPO]])), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert({ resourceKind: null }), facts(new Map([[APP, REPO]])), EMPTY_BOOK, now)).toEqual([]);
    expect(proposalsFor(alert(), facts(new Map([[APP, "not-a-uuid"]])), EMPTY_BOOK, now)).toEqual([]);
  });

  it("asks the database layer for these apps only", () => {
    expect(factNeeds([alert()], now).depApps).toEqual([APP]);
    expect(factNeeds([alert({ silencedUntilResolved: true })], now).depApps).toEqual([]);
  });
});
