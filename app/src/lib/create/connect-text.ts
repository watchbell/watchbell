import { ENV_COPY } from "@/lib/copy/edition";

// Stage 6 create requests, Firebase: the words around the Owner's "Connect Google (create projects)" grant. Pure, so the
// client dialog and the Firebase page can import it (lib/create/google-connect.ts uses node:crypto through google-oauth).

// What the Firebase page says before the Owner connects (spec: be honest about the scope and the warning screen).
export const CONNECT_EXPLAINER = [
  "This asks Google for the cloud-platform permission: it is broad (it can manage every Google Cloud project you own), so the console uses it only to create a project and add Firebase to it after your approval, and never to change or delete anything.",
  "Google shows an \"unverified app\" warning because Watchbell's OAuth client isn't verified for this scope. It is your own client for your own use: choose Advanced → Go to Watchbell.",
  "While the OAuth consent screen is in Testing mode, Google ends this grant after 7 days; connect again when a create says so. Remove it any time in your Google Account → Security → Third-party access.",
] as const;

export const CREATE_CALLBACK_TEXT: Record<string, { tone: "ok" | "danger"; text: string }> = {
  connected: { tone: "ok", text: "Google connected for creating projects. Ask for a new Firebase project below; it still needs your approval." },
  denied: { tone: "danger", text: "Google wasn't connected: the permission was declined on Google's page." },
  expired: { tone: "danger", text: "The connect link expired (10 minutes). Start again." },
  state: { tone: "danger", text: "That answer from Google didn't match the connect you started here, so it was ignored. Start again." },
  member: { tone: "danger", text: "The connect was started by another sign-in. Start again from this one." },
  missing: { tone: "danger", text: "Google didn't send an authorisation code. Start again." },
  refused: { tone: "danger", text: "Google refused the authorisation. Check the OAuth client and its redirect URI, then start again." },
  scope: { tone: "danger", text: "The Google Cloud permission wasn't granted, or Google sent no refresh token. Connect again and allow it." },
  env: { tone: "danger", text: ENV_COPY.notSet("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET", true) },
  failed: { tone: "danger", text: "Google couldn't be connected. Try again in a minute." },
};
