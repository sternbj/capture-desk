import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", png: "image/png", svg: "image/svg+xml", json: "application/json",
};
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1:" + port);
    let path = resolve(root, "." + decodeURIComponent(url.pathname));
    if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) throw new Error("Invalid path");
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    const type = types[path.split(".").pop()];
    if (!type) throw new Error("Unsupported file");
    response.writeHead(200, {
      "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : await readFile(path));
  } catch {
    if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Capture Desk at http://127.0.0.1:${port}/standalone/`));
