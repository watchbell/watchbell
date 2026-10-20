import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret, DATABASE_URL: dbUrl, OWNER_EMAIL: rawEmail } = process.env;
if (!url || !secret || !dbUrl || !rawEmail) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL and OWNER_EMAIL in app/.env.local first.");
  process.exit(1);
}
const email = rawEmail.trim().toLowerCase();

let sql: ReturnType<typeof postgres> | undefined;
try {
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  // Inside the try: postgres parses the URL eagerly, and a bad URL error would echo the password.
  sql = postgres(dbUrl, { prepare: false, max: 1, ssl: "require" });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ops.members where role = 'owner'`;
  if (n > 0) {
    console.log("An owner already exists. Nothing to do.");
  } else {
    let userId: string | undefined;
    const created = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (created.data.user) {
      userId = created.data.user.id;
    } else {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw new Error(`Couldn't list auth users: ${error.message}`);
      userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id;
    }
    if (!userId) throw new Error("Couldn't find or create the owner's auth user.");
    await sql`insert into ops.members (user_id, email, role) values (${userId}, ${email}, 'owner')`;
    console.log(`Owner ready: ${email}. Sign in at /signin.`);
  }
} catch (e) {
  // Never print the error object for a URL failure: Node's uncaught print includes the input URL.
  if (typeof e === "object" && e !== null && "code" in e && e.code === "ERR_INVALID_URL") {
    console.error("DATABASE_URL isn't a valid URL. If your database password has special characters (# @ [ ] / ? :), URL-encode them.");
  } else {
    console.error(e instanceof Error ? e.message : "Bootstrap failed.");
  }
  process.exitCode = 1;
} finally {
  await sql?.end();
}
