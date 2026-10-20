import { describe, expect, it } from "vitest";
import { openInLinks } from "./open-in";

const base = { teamSlug: "acme-team", projectName: "shortly", repo: "acme/shortly", repoType: "github", siteUrl: "https://shortly.example.com", dbs: [], zone: null };

describe("openInLinks (P2)", () => {
  it("Vercel project, Git repository and the live site", () => {
    expect(openInLinks(base)).toEqual([
      { label: "Vercel project", href: "https://vercel.com/acme-team/shortly" },
      { label: "Git repository", href: "https://github.com/acme/shortly" },
      { label: "Live site", href: "https://shortly.example.com" },
    ]);
  });
  it("adds the linked databases and the Cloudflare zone after a separator", () => {
    expect(openInLinks({ ...base, dbs: [{ kind: "supabase_project", externalId: "abcd1234", name: "portfolio" }, { kind: "neon_project", externalId: "np-1", name: "ticketer" }, { kind: "firestore", externalId: "nova-wallet", name: "nova-wallet" }],
      zone: { accountId: "acc123", name: "example.com" } }).slice(3)).toEqual([
      "---",
      { label: "Supabase · portfolio", href: "https://supabase.com/dashboard/project/abcd1234" },
      { label: "Neon · ticketer", href: "https://console.neon.tech/app/projects/np-1" },
      { label: "Firebase · nova-wallet", href: "https://console.firebase.google.com/project/nova-wallet/overview" },
      { label: "Cloudflare · example.com", href: "https://dash.cloudflare.com/acc123/example.com" },
    ]);
  });
  it("leaves out what isn't known: no team slug, no repo, an unknown git host, no zone account", () => {
    expect(openInLinks({ ...base, teamSlug: null, repo: null, zone: { accountId: null, name: "example.com" } })).toEqual([{ label: "Live site", href: "https://shortly.example.com" }]);
    expect(openInLinks({ ...base, repoType: "azure" }).map((x) => (x === "---" ? x : x.label))).toEqual(["Vercel project", "Live site"]);
    expect(openInLinks({ ...base, repoType: "gitlab" })[1]).toEqual({ label: "Git repository", href: "https://gitlab.com/acme/shortly" });
  });
});
