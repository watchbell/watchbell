// Watchbell 1.8.6: read a request body as text, at most `max` bytes. The bytes are counted as they arrive, so a missing
// or lying Content-Length can't make the server hold more than `max` (+ one chunk) in memory.
export async function readCapped(req: Request, max: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false };
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return { ok: false }; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { ok: true, text: new TextDecoder().decode(all) };
}
