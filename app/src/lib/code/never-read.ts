// Files whose text Watchbell never reads from a repository: secrets, keys, env, lockfiles, build output, binaries.
// Shared by the office's Dev officer (src/private/office, as DEV_NEVER_READ) and the GitHub repository browser. Pure.

// Secrets: env files, keys and certificates, SSH keys, anything named like a secret or a credential.
const SECRET = [/(^|\/)\.env(\.|$)/i, /\.(pem|key|p12|pfx|crt|cer|keystore|jks)$/i, /(^|\/)(id_rsa|id_ed25519)/i, /secret/i, /credential/i];
// Generated: dependencies, build output, VCS internals and lockfiles.
const GENERATED = [/(^|\/)(node_modules|\.next|dist|build|out|coverage|\.vercel|\.git)\//, /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i];
// Binaries by extension.
const BINARY = [/\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|mp4|mp3|wasm)$/i];

export const NEVER_READ: RegExp[] = [...SECRET, ...GENERATED, ...BINARY];

export type HiddenReason = "secret" | "generated" | "binary";

// Why a path is never read, or null when it may be. A path that climbs ("..") or is empty counts as a secret: refused.
export function hiddenReason(path: string): HiddenReason | null {
  if (!path || path.split("/").includes("..")) return "secret";
  if (SECRET.some((re) => re.test(path))) return "secret";
  if (GENERATED.some((re) => re.test(path))) return "generated";
  if (BINARY.some((re) => re.test(path))) return "binary";
  return null;
}

export const HIDDEN_TEXT: Record<HiddenReason, string> = {
  secret: "hidden (secret file)",
  generated: "hidden (generated file)",
  binary: "binary, not shown",
};
