const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route params and action arguments reach SQL only as real UUIDs (Postgres answers anything else with an error).
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
