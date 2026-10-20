import { handleChat } from "@/private/ai/gateway";

// POST /api/v1/ai/chat/completions (scope ai:invoke): OpenAI-compatible, forwarded to the owner's own provider (R4).
// Request-time by nature (POST, API key); no `dynamic` export (removed in Next 16 under Cache Components).
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleChat(request);
}
