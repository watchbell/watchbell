// Watchbell 1.6 (spec §6 Hosting, mockup view "hosting"): where an app can run, per language. Plain data, read from
// each provider's official pricing and docs pages on HOSTING_CHECKED_ON (docs/research/2026-11-12-free-hosting-recheck.md).
// Free tiers change: re-check every release and move the date on.

export type HostCost = "free" | "free-card" | "trial" | "paid" | "guide";

// Hosts Watchbell syncs as applications once connected (Connections). Cloudflare is connected for DNS, TLS and D1
// only: its Workers and Pages aren't synced as applications (review I1), so it is a plain host here.
export type HostedProvider = "vercel";

export type Host = {
  id: string;
  name: string;
  cost: HostCost;
  price: string; // shown in the Cost column: "Free", "Free, card", "$5 trial", "$7/mo", "Guide"
  from: string; // how it deploys: "git / CLI", "Docker", "FTP"
  newUrl: string; // the provider's own new-project page (or its dashboard where no deep link is documented)
  // Where to click once there ("New › Web Service"). The repository never goes into the link: every documented
  // pre-fill either copies the repository into a new one or needs a config file in it (12 Nov re-check §2).
  // "{repo}" in it is replaced by the chosen repository.
  menu?: string;
  picksRepo?: false; // false: there is no repository to pick on the host (FTP, file upload, or the repository's own settings)
  provider?: HostedProvider;
  guide?: string[]; // guide-only hosts: the steps, ending with adding the address to Uptime
  source: string; // the official page this row was read from
};

export type LangId = "nextjs" | "static" | "node" | "python" | "php" | "go" | "java" | "dotnet" | "ruby" | "docker";

export type LangTile = {
  id: LangId;
  label: string;
  github: string[]; // GitHub's language names that pre-select this tile
  fits?: string[]; // other GitHub languages this tile suits: choosing such a repository keeps the tile (TypeScript on Next.js)
  note: string; // the one-sentence verdict above the host table
  hosts: { host: string; catch: string }[]; // in order: free, free with a card, trial, paid, guide
};

export const COST_RANK: Record<HostCost, number> = { free: 0, "free-card": 1, trial: 2, paid: 3, guide: 4 };

export const HOSTING_CHECKED_ON = "11 Nov 2026";

// Left out on purpose (12 Nov): Koyeb (no free plan on its pricing page), Replit (pricing page shows no free plan),
// Zeabur (the free plan is a server you bring), Glitch and 000webhost (closed).
const UPTIME = "Copy the app's address and add it to Uptime in Watchbell.";

export const HOSTS: Record<string, Host> = {
  vercel: { id: "vercel", name: "Vercel", cost: "free", price: "Free", from: "git / CLI", newUrl: "https://vercel.com/new", provider: "vercel", source: "https://vercel.com/pricing" },
  cloudflare: { id: "cloudflare", name: "Cloudflare", cost: "free", price: "Free", from: "git / Wrangler", newUrl: "https://dash.cloudflare.com/?to=/:account/workers-and-pages", menu: "Workers & Pages › Create application", source: "https://developers.cloudflare.com/workers/platform/pricing/" },
  netlify: { id: "netlify", name: "Netlify", cost: "free", price: "Free", from: "git / CLI", newUrl: "https://app.netlify.com/start", source: "https://www.netlify.com/pricing/" },
  "github-pages": { id: "github-pages", name: "GitHub Pages", cost: "free", price: "Free", from: "git / Actions", newUrl: "https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site", menu: "open {repo} on GitHub, then Settings › Pages", picksRepo: false, source: "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits" },
  "do-static": { id: "do-static", name: "DigitalOcean (static)", cost: "free", price: "Free", from: "git", newUrl: "https://cloud.digitalocean.com/apps/new", menu: "Create App, choose a static site", source: "https://docs.digitalocean.com/products/app-platform/details/pricing/" },
  deno: { id: "deno", name: "Deno Deploy", cost: "free", price: "Free", from: "git / CLI", newUrl: "https://console.deno.com/", menu: "+ New App", source: "https://deno.com/deploy/pricing" },
  render: { id: "render", name: "Render", cost: "free", price: "Free", from: "git / Docker", newUrl: "https://dashboard.render.com/", menu: "New › Web Service", source: "https://render.com/docs/free" },
  pythonanywhere: { id: "pythonanywhere", name: "PythonAnywhere", cost: "free", price: "Free", from: "files / git", newUrl: "https://www.pythonanywhere.com/pricing/", menu: "sign up, then Web › Add a new web app", picksRepo: false, source: "https://help.pythonanywhere.com/pages/FreeAccountsFeatures/" },
  infinityfree: { id: "infinityfree", name: "InfinityFree", cost: "free", price: "Free", from: "FTP", newUrl: "https://dash.infinityfree.com/register", menu: "create a hosting account, then upload the files over FTP", picksRepo: false, source: "https://www.infinityfree.com/" },
  back4app: { id: "back4app", name: "Back4app", cost: "free", price: "Free", from: "git + Dockerfile", newUrl: "https://www.back4app.com/pricing/container-as-a-service", menu: "sign up, then Containers › New app", source: "https://www.back4app.com/pricing/container-as-a-service" },
  northflank: { id: "northflank", name: "Northflank", cost: "free-card", price: "Free, card may be asked", from: "git / Docker", newUrl: "https://app.northflank.com/", menu: "Create new › Service", source: "https://northflank.com/pricing" },
  railway: { id: "railway", name: "Railway", cost: "trial", price: "$5 trial, then $1 credit or $5/mo", from: "git / Docker", newUrl: "https://railway.com/new", menu: "Deploy from GitHub repo", source: "https://railway.com/pricing" },
  fly: { id: "fly", name: "Fly.io", cost: "trial", price: "$1 trial, then from $2.19/mo", from: "Docker / CLI", newUrl: "https://fly.io/dashboard", menu: "Launch an app from GitHub", source: "https://docs.fly.io/about/pricing" },
  "laravel-cloud": { id: "laravel-cloud", name: "Laravel Cloud", cost: "trial", price: "1st month free, then $5 + usage", from: "git", newUrl: "https://cloud.laravel.com/sign-up?plan=starter", menu: "New application, then connect the repository", source: "https://laravel.com/cloud/pricing" },
  heroku: { id: "heroku", name: "Heroku", cost: "paid", price: "From $5/mo", from: "git / Docker", newUrl: "https://dashboard.heroku.com/", menu: "New › Create new app, then Deploy › GitHub", source: "https://www.heroku.com/pricing/" },
  "cloud-run": {
    id: "cloud-run", name: "Google Cloud Run", cost: "guide", price: "Guide, card", from: "source / Docker", newUrl: "https://console.cloud.google.com/run", source: "https://docs.cloud.google.com/free/docs/free-cloud-features",
    guide: [
      "Create a Google Cloud project and turn on billing: a card is needed, and the free tier (2 million requests a month) still applies.",
      "In Cloud Run choose Connect repository to build from GitHub, or Deploy container for an image.",
      "Allow unauthenticated invocations if it's a public site, then create the service.",
      UPTIME,
    ],
  },
  oracle: {
    id: "oracle", name: "Oracle VM + Coolify", cost: "guide", price: "Guide, card", from: "VM", newUrl: "https://cloud.oracle.com/", source: "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm",
    guide: [
      "Create an Oracle Cloud account (a card is checked) and an Always Free Arm instance (up to 2 OCPU and 12 GB RAM in total).",
      "Install Coolify or Dokploy on it, then deploy the repository from their dashboard.",
      "Keep it in use: Oracle reclaims Always Free VMs that stay idle for 7 days.",
      UPTIME,
    ],
  },
  azure: {
    id: "azure", name: "Azure App Service F1", cost: "guide", price: "Guide, card", from: "git / zip", newUrl: "https://portal.azure.com/#create/Microsoft.WebSite", source: "https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#app-service-limits",
    guide: [
      "Create an Azure account (a card is checked).",
      "Create a Web App and pick Free F1 under Pricing plan: 60 CPU minutes a day, and no custom domain.",
      "Connect the GitHub repository under Deployment Center.",
      "Copy the azurewebsites.net address and add it to Uptime in Watchbell.",
    ],
  },
};

const RENDER_SLEEPS = "Sleeps after 15 min idle; 512 MB";
const NF = "2 services, always on, not for production; may ask for a card";
const RAILWAY = "After the trial, $1 a month of credit";

export const LANGS: LangTile[] = [
  {
    id: "nextjs", label: "Next.js", github: [], fits: ["JavaScript", "TypeScript"],
    note: "Vercel Hobby is the easiest free host for Next.js, for non-commercial projects. Cloudflare runs it through the OpenNext adapter.",
    hosts: [
      { host: "vercel", catch: "Non-commercial only; hard caps, no paying for more" },
      { host: "cloudflare", catch: "OpenNext adapter; 10 ms CPU per request, 100k requests a day" },
      { host: "netlify", catch: "300 credits a month (about 20 deploys), then paused" },
      { host: "render", catch: RENDER_SLEEPS },
      { host: "railway", catch: RAILWAY },
      { host: "cloud-run", catch: "Billing account needed; generous free quota" },
    ],
  },
  {
    id: "static", label: "Static site", github: ["HTML", "CSS", "SCSS"], fits: ["JavaScript", "TypeScript"],
    note: "Static sites are free almost everywhere; GitHub Pages and Cloudflare Pages have the fewest catches.",
    hosts: [
      { host: "github-pages", catch: "1 GB site; no commercial SaaS or online shop" },
      { host: "cloudflare", catch: "500 builds a month" },
      { host: "netlify", catch: "300 credits a month (about 20 deploys), then paused" },
      { host: "vercel", catch: "Non-commercial only" },
      { host: "do-static", catch: "3 static sites, 1 GiB transfer each" },
    ],
  },
  {
    id: "node", label: "Node.js", github: ["JavaScript", "TypeScript"],
    note: "For a long-running Node server, Render's free plan works but sleeps after 15 minutes. Northflank stays on but may ask for a card.",
    hosts: [
      { host: "render", catch: RENDER_SLEEPS },
      { host: "deno", catch: "Deno and Node apps; 512 MB, 10 CPU-hours a month" },
      { host: "vercel", catch: "As functions, not a long-running server; non-commercial" },
      { host: "northflank", catch: NF },
      { host: "railway", catch: RAILWAY },
      { host: "fly", catch: "Card after the 7-day trial" },
      { host: "heroku", catch: "Eco ($5) sleeps after 30 min; Basic ($7) stays on" },
      { host: "cloud-run", catch: "Billing account needed; cold starts" },
    ],
  },
  {
    id: "python", label: "Python", github: ["Python", "Jupyter Notebook"],
    note: "Render's free plan runs Django or FastAPI and sleeps after 15 minutes. Vercel and Cloudflare suit function-style apps.",
    hosts: [
      { host: "render", catch: RENDER_SLEEPS },
      { host: "vercel", catch: "FastAPI, Flask or Django as functions; non-commercial" },
      { host: "cloudflare", catch: "Python Workers: part of the standard library; 10 ms CPU" },
      { host: "pythonanywhere", catch: "One app, renewed every month; no MySQL on new accounts" },
      { host: "northflank", catch: NF },
      { host: "railway", catch: RAILWAY },
      { host: "cloud-run", catch: "Billing account needed; cold starts" },
    ],
  },
  {
    id: "php", label: "PHP", github: ["PHP", "Blade", "Hack"],
    note: "WordPress fits InfinityFree (FTP only, so Watchbell can only watch its address). Laravel runs on Render through Docker.",
    hosts: [
      { host: "infinityfree", catch: "WordPress or plain PHP + MySQL; FTP only; needs visits each month" },
      { host: "render", catch: "Docker only; the free database expires after 30 days" },
      { host: "northflank", catch: "Docker; may ask for a card" },
      { host: "laravel-cloud", catch: "Made for Laravel; scales to zero" },
      { host: "railway", catch: RAILWAY },
      { host: "oracle", catch: "Full LAMP on a free VM; you run the server" },
    ],
  },
  {
    id: "go", label: "Go", github: ["Go"],
    note: "Render's free plan runs a Go server and sleeps after 15 minutes.",
    hosts: [
      { host: "render", catch: RENDER_SLEEPS },
      { host: "vercel", catch: "One handler per function; non-commercial" },
      { host: "northflank", catch: NF },
      { host: "fly", catch: "Card after the 7-day trial" },
      { host: "railway", catch: RAILWAY },
      { host: "cloud-run", catch: "Billing account needed; cold starts" },
    ],
  },
  {
    id: "java", label: "Java", github: ["Java", "Kotlin", "Groovy", "Scala"],
    note: "No free host is comfortable for Spring Boot: 512 MB barely fits the JVM. Oracle's free Arm VM works if you run the server yourself.",
    hosts: [
      { host: "render", catch: "Docker; 512 MB is tight for the JVM; sleeps after 15 min" },
      { host: "vercel", catch: "Dockerfile (Beta); scales to zero after 5 min; non-commercial" },
      { host: "northflank", catch: "Limited CPU is tight for the JVM; may ask for a card" },
      { host: "railway", catch: "Pay for the RAM it uses; the free $1 credit won't fit a JVM" },
      { host: "heroku", catch: "Basic ($7) stays on" },
      { host: "oracle", catch: "12 GB of Arm RAM; idle VMs are reclaimed" },
      { host: "cloud-run", catch: "Billing account needed; slow cold starts" },
    ],
  },
  {
    id: "dotnet", label: ".NET", github: ["C#", "F#", "Visual Basic .NET"],
    note: "Free options for .NET are weak: Render through Docker, or Azure F1 (card, 60 CPU minutes a day, no custom domain).",
    hosts: [
      { host: "render", catch: "Docker; sleeps after 15 min" },
      { host: "vercel", catch: "Dockerfile (Beta); non-commercial" },
      { host: "northflank", catch: "Docker; may ask for a card" },
      { host: "railway", catch: RAILWAY },
      { host: "heroku", catch: "Native .NET; Basic ($7) stays on" },
      { host: "azure", catch: "60 CPU minutes a day; no custom domain" },
      { host: "cloud-run", catch: "Billing account needed" },
    ],
  },
  {
    id: "ruby", label: "Ruby", github: ["Ruby"],
    note: "Render's free plan runs Rails and sleeps after 15 minutes; its free database expires after 30 days.",
    hosts: [
      { host: "render", catch: "Sleeps after 15 min; the free database expires after 30 days" },
      { host: "northflank", catch: NF },
      { host: "railway", catch: RAILWAY },
      { host: "heroku", catch: "Eco ($5) sleeps after 30 min" },
      { host: "cloud-run", catch: "Billing account needed" },
    ],
  },
  {
    id: "docker", label: "Docker image", github: ["Dockerfile"], fits: ["JavaScript", "TypeScript", "Python", "Go", "Java", "PHP", "Ruby", "C#"],
    note: "Any image runs on Render's free plan (512 MB, sleeps after 15 minutes). Vercel builds a plain Dockerfile too, in Beta and non-commercial.",
    hosts: [
      { host: "render", catch: RENDER_SLEEPS },
      { host: "vercel", catch: "Plain Dockerfile (Beta); scales to zero after 5 min; non-commercial" },
      { host: "back4app", catch: "256 MB; a Dockerfile in the repository" },
      { host: "northflank", catch: NF },
      { host: "fly", catch: "Card after the 7-day trial" },
      { host: "railway", catch: RAILWAY },
      { host: "cloud-run", catch: "Billing account needed" },
      { host: "oracle", catch: "Coolify or Dokploy on a free VM; you run the server" },
    ],
  },
];

// The official pages read on HOSTING_CHECKED_ON.
export const HOSTING_SOURCES: [string, string][] = [
  ["Vercel", "https://vercel.com/pricing"],
  ["Cloudflare Workers", "https://developers.cloudflare.com/workers/platform/pricing/"],
  ["Netlify", "https://www.netlify.com/pricing/"],
  ["GitHub Pages", "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits"],
  ["Render", "https://render.com/docs/free"],
  ["Deno Deploy", "https://deno.com/deploy/pricing"],
  ["Northflank", "https://northflank.com/pricing"],
  ["Railway", "https://railway.com/pricing"],
  ["Fly.io", "https://docs.fly.io/about/pricing"],
  ["Heroku", "https://www.heroku.com/pricing/"],
  ["PythonAnywhere", "https://help.pythonanywhere.com/pages/FreeAccountsFeatures/"],
  ["InfinityFree", "https://www.infinityfree.com/"],
  ["Laravel Cloud", "https://laravel.com/cloud/pricing"],
  ["Back4app", "https://www.back4app.com/pricing/container-as-a-service"],
  ["DigitalOcean App Platform", "https://docs.digitalocean.com/products/app-platform/details/pricing/"],
  ["Google Cloud free tier", "https://docs.cloud.google.com/free/docs/free-cloud-features"],
  ["Azure App Service limits", "https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#app-service-limits"],
  ["Oracle Always Free", "https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm"],
];
