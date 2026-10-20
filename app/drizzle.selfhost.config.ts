import { defineConfig } from "drizzle-kit";
import base from "./drizzle.config";

// Self-host (PGlite or a user's own Postgres) gets one squashed baseline generated from the same Drizzle schema. Cloud
// keeps its hand-applied history in ./drizzle (with the Supabase grants and RLS lock-downs), which this never touches.
export default defineConfig({
  dialect: "postgresql",
  schema: base.schema,
  out: "./drizzle-selfhost",
  schemaFilter: base.schemaFilter,
});
