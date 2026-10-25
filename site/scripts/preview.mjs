// Serves out/ the way Vercel does for this site (clean URLs: /docs/install → docs/install.html, 404.html for misses).
// Usage: npm run build && npm run preview  [-- --port 3200]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 3200);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
};

function resolve(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^[\\/]+/, "");
  const base = path.join(root, clean);
  if (!base.startsWith(root)) return null;
  for (const candidate of [base, `${base}.html`, path.join(base, "index.html")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

if (!fs.existsSync(root)) {
  console.error("out/ is missing: run `npm run build` first.");
  process.exit(1);
}

http
  .createServer((req, res) => {
    const file = resolve(req.url || "/");
    const status = file ? 200 : 404;
    const body = file ?? path.join(root, "404.html");
    res.writeHead(status, { "Content-Type": types[path.extname(body)] || "application/octet-stream" });
    fs.createReadStream(body).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`Serving out/ at http://localhost:${port}`));
