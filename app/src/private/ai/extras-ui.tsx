// The open source edition's AI extras UI (exported as extras-ui.tsx): the same names as the private edition's, with
// nothing to show. The Models page leaves out its agent section ("none"); AI › Usage and AI › Quota have no router quota
// and no agent card.

export const antigravityView: (now: Date) => Promise<"none"> = async () => "none";
export const AntigravitySection: (props: { view: never; now: Date }) => null = () => null;
export const antigravityQuota: (now: Date) => Promise<null> = async () => null;
export const AntigravityQuotaCard: (props: { ag: never }) => null = () => null;
export const RouterQuotaCard: (props: { report: unknown; now: Date }) => null = () => null;
export const routerQuotaView: (now: Date) => Promise<null> = async () => null;
export const RouterQuotaSection: (props: { view: unknown; now: Date }) => null = () => null;
// AI › Quota's subtitle, without the router (no line about it under "Where these numbers come from").
export const QUOTA_PAGE_TEXT: { sub: string; sourceNote: string | null } = {
  sub: "What each provider did through Watchbell, and each console key's own limit.",
  sourceNote: null,
};
