import { apiError } from "@/private/api/respond";

// Any /api/v1 path without its own route (13 Oct): 404 JSON, never a page. Without this the console's catch-all page
// ((console)/[...slug]) took the path, and its layout's sign-in check answered 307 to /signin with HTML, which
// PowerShell's Invoke-RestMethod followed silently. Every real /api/v1 route is a static segment, which Next matches
// before this optional catch-all, so they are unaffected. Answers the same for every method, without reading the key.
const notFound = () => apiError("not_found", "No such endpoint. See /api/v1/openapi.json.", 404);

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
