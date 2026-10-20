import { requireActionMember } from "@/lib/auth";
import { apiError, apiJson } from "@/private/api/respond";
import { authenticateApiKey } from "@/private/auth/api-key";
import { originFrom } from "@/private/explorer/origin";
import { openApiDocument } from "@/private/openapi/spec";

export const dynamic = "force-dynamic";

// GET /api/v1/openapi.json: the OpenAPI 3.1 document. Any valid console key, OR the owner's signed-in session (so the
// explorer's download button works). This is the ONE /api/v1 route that may read the session (R2), and it is read-only
// and holds nothing secret. A request that sends an Authorization header is judged by the key alone.
export async function GET(req: Request): Promise<Response> {
  if (req.headers.get("authorization")) {
    const auth = await authenticateApiKey(req, "any");
    if (!auth.ok) return auth.response;
  } else {
    const owner = await requireActionMember("owner").then(() => true, () => false);
    if (!owner) return apiError("invalid_api_key", "Send a console API key (Authorization: Bearer wb_…), or open this while signed in as the owner.", 401);
  }
  return apiJson(openApiDocument(originFrom(req.headers, new URL(req.url).origin)));
}
