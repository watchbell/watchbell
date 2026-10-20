import "server-only";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { demoPglite } from "./facade";

// db() in demo: one Drizzle instance for every visitor; the facade routes each query to the current visitor's database.
// Only ever loaded through ready() in demo mode, so cloud and self-host never load PGlite for it.
export const demoDb: Db = drizzle({ client: demoPglite, schema });
