import { handleModels } from "@/private/ai/gateway";

// GET /api/v1/ai/models (scope ai:invoke): enabled models across enabled connections, OpenAI list format.
export async function GET(request: Request): Promise<Response> {
  return handleModels(request);
}
