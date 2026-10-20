import "server-only";
import postgres from "postgres";
import type { Dsn } from "./dsn";
import type { PgConn } from "./run";

// The postgres.js side of lib/sql/run.ts. One client per run with a single connection (max 1), no prepared statements
// (the poolers need that), a 5 s connect timeout and TLS. The options are explicit, never a URL, so no query parameter
// of the pasted string becomes a startup setting. The user query goes through the extended protocol (a portal with a
// row limit), which Postgres refuses for more than one statement: a second guard behind lib/sql/guard.ts.
export async function connectPg(dsn: Dsn): Promise<PgConn> {
  const sql = postgres({
    host: dsn.host, port: dsn.port, user: dsn.user, password: dsn.password, database: dsn.database,
    ssl: "require", max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5, max_lifetime: 60,
    fetch_types: false, onnotice: () => undefined, connection: { application_name: "watchbell-sql-console" },
  });
  return {
    async exec(text) {
      await sql.unsafe(text);
    },
    async rows(text, max) {
      const rows: unknown[][] = [];
      let columns: string[] = [];
      const take = (batch: { columns?: { name: string }[] } & unknown[]) => {
        if (!columns.length && batch.columns) columns = batch.columns.map((c) => c.name);
        for (const r of batch) if (rows.length < max) rows.push(r as unknown[]);
      };
      const final = await sql.unsafe(text).values().cursor(max, (batch) => {
        take(batch as unknown as { columns?: { name: string }[] } & unknown[]);
        return sql.CLOSE;
      });
      const meta = final as unknown as { columns?: { name: string }[] } | undefined;
      if (!columns.length && meta?.columns) columns = meta.columns.map((c) => c.name);
      return { columns, rows };
    },
    async close() {
      await sql.end({ timeout: 0 });
    },
  };
}
