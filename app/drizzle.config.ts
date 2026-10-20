import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // The private feature's tables (5c) live in src/private/db; the glob matches nothing when that folder is absent.
  schema: ["./src/db/schema.ts", "./src/db/compute-schema.ts", "./src/db/sql-schema.ts", "./src/db/create-schema.ts", "./src/db/runner-schema.ts", "./src/private/db/!(*.test).ts"],
  out: "./drizzle",
  schemaFilter: ["ops"],
});
