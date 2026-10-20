// Self-host account recovery: `npm run reset-login -- <email>`, run in the app folder while Watchbell is stopped.
// Gives the account a new temporary password (printed once, here), removes its authenticator and ends its sessions;
// the person signs in with it, picks a new password and sets the authenticator up again. The work is resetLogin()
// (src/lib/local-auth/reset-login.ts); this file only finds the database and prints the result.
//
// Like scripts/start-selfhost.mjs, an unset DATABASE_URL means the local PGlite database ("pglite:"), and app/.env.local
// is never read, so a cloud folder's production DATABASE_URL can't be reached by accident. A hosted Supabase database
// is always refused: cloud accounts live in Supabase Auth, not here.
import { statSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Plain `node` runs this (type stripping, as for scripts/bootstrap-owner.mts), but the app's modules use the "@/"
// alias, extensionless relative imports and the "server-only" marker. These hooks resolve those three for src/ only.
const SRC = new URL("../src/", import.meta.url);
const tsFile = (url: URL): string | null => {
  for (const candidate of [`${url.href}.ts`, `${url.href}/index.ts`, url.href]) {
    try {
      if (statSync(fileURLToPath(candidate)).isFile()) return candidate;
    } catch {
      // not this one
    }
  }
  return null;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    const fromSrc = context.parentURL?.startsWith(SRC.href) === true;
    const target = specifier.startsWith("@/")
      ? new URL(specifier.slice(2), SRC)
      : fromSrc && /^\.\.?\//.test(specifier)
        ? new URL(specifier, context.parentURL)
        : null;
    const url = target && tsFile(target);
    return url ? { url, format: "module-typescript", shortCircuit: true } : nextResolve(specifier, context);
  },
});

const USAGE = "Usage: npm run reset-login -- <email>   (in the app folder, with Watchbell stopped)";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].trim() || args[0].startsWith("-")) {
    console.error(USAGE);
    return 1;
  }
  const { mode, remoteDbRisk } = await import("@/lib/mode");
  const { readEnvNamed } = await import("@/lib/brand-env");
  let current: string;
  try {
    current = mode();
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  // Unset WATCHBELL_MODE (and WATCHPOST_MODE) is fine (this tool is self-host only by nature); an explicit cloud or demo is not.
  const modeVar = readEnvNamed(process.env, "MODE");
  if (modeVar?.value.trim() && current !== "selfhost") {
    console.error(`reset-login is for self-hosted Watchbell only (${modeVar.name} is ${current}). Cloud sign-ins are managed in Supabase Auth.`);
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL || "pglite:";
  if (remoteDbRisk({ DATABASE_URL: databaseUrl })) {
    console.error("Refusing: DATABASE_URL points at a hosted Supabase database, or is not a URL this tool can vouch for. reset-login only works on a self-host database.");
    return 1;
  }

  const { resetLogin } = await import("@/lib/local-auth/reset-login");
  let close: () => Promise<void>;
  let db: Parameters<typeof resetLogin>[0];
  if (databaseUrl.startsWith("pglite:")) {
    const { dataDir, openPglite } = await import("@/db/pglite");
    const dir = dataDir();
    try {
      if (!statSync(dir).isDirectory()) throw new Error("not a folder");
    } catch {
      console.error(`No Watchbell database in ${dir}. Run this in the folder you start Watchbell from, or set WATCHBELL_DATA_DIR.`);
      return 1;
    }
    try {
      // Refused while the server holds the folder (its lock file names a running process).
      ({ db, close } = await openPglite(dir));
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      console.error(
        /already using/.test(message)
          ? `Watchbell is running on ${dir}. Stop Watchbell first, then run reset-login again.`
          : "Couldn't open the database.",
      );
      return 1;
    }
  } else {
    // A self-host install on its own Postgres, opened the way src/db/client.ts does.
    const [{ default: postgres }, { drizzle }, schema] = await Promise.all([import("postgres"), import("drizzle-orm/postgres-js"), import("@/db/schema")]);
    let client: ReturnType<typeof postgres>;
    try {
      client = postgres(databaseUrl, { prepare: false, max: 1, ssl: "require", connect_timeout: 10 });
    } catch {
      // Never print the error: a URL parse error includes the URL, password and all.
      console.error("DATABASE_URL isn't a valid URL. If your database password has special characters (# @ [ ] / ? :), URL-encode them.");
      return 1;
    }
    db = drizzle({ client, schema }) as unknown as typeof db;
    close = () => client.end();
  }

  try {
    const r = await resetLogin(db, args[0]);
    if (!r.ok) {
      console.error(`No account with the email ${args[0].trim().toLowerCase()} on this Watchbell.`);
      return 1;
    }
    console.log(`Login reset for ${r.email}.`);
    console.log(`Temporary password (shown only now): ${r.password}`);
    console.log(`It works until ${r.expiresAt.toISOString()} (7 days). Their sessions were ended and their authenticator removed:`);
    console.log("at the next sign-in they choose a new password and, if their role needs one, set up an authenticator again.");
    return 0;
  } catch (e) {
    // Never print e.message: drizzle appends the SQL and its bound params (email, password hash). The SQLSTATE alone is safe.
    const code = (e as { code?: unknown } | null)?.code;
    console.error(`Couldn't reset the login, nothing was changed.${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (database error ${code})` : ""}`);
    return 1;
  } finally {
    await close();
  }
}

process.exitCode = await main();
