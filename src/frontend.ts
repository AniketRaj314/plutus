import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

const PUBLIC_ROOT = path.resolve(process.cwd(), "public");

interface FrontendAsset {
  file: string;
  type: string;
  cacheControl: string;
}

const ASSETS: Record<string, FrontendAsset> = {
  "/assets/plutus.css": {
    file: "assets/plutus.css",
    type: "text/css; charset=utf-8",
    cacheControl: "public, max-age=3600",
  },
  "/assets/plutus.js": {
    file: "assets/plutus.js",
    type: "text/javascript; charset=utf-8",
    cacheControl: "public, max-age=3600",
  },
  "/assets/violet.jpg": {
    file: "assets/violet.jpg",
    type: "image/jpeg",
    cacheControl: "public, max-age=604800, immutable",
  },
  "/assets/plutus-og.png": {
    file: "assets/plutus-og.png",
    type: "image/png",
    cacheControl: "public, max-age=604800, immutable",
  },
};

async function sendFile(reply: FastifyReply, asset: FrontendAsset): Promise<FastifyReply> {
  const body = await readFile(path.join(PUBLIC_ROOT, asset.file));
  return reply
    .header("Cache-Control", asset.cacheControl)
    .type(asset.type)
    .send(body);
}

export function registerFrontendRoutes(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => {
    const body = await readFile(path.join(PUBLIC_ROOT, "index.html"), "utf8");
    return reply
      .header(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
      )
      .header("Referrer-Policy", "strict-origin-when-cross-origin")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header("Cache-Control", "public, max-age=300")
      .type("text/html; charset=utf-8")
      .send(body);
  });

  for (const [route, asset] of Object.entries(ASSETS)) {
    app.get(route, async (_request, reply) => sendFile(reply, asset));
  }
}
