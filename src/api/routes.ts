import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { handleTelegramUpdate, type TelegramUpdate } from "../telegram/bot";

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post("/webhook/telegram", async (request, reply) => {
    reply.status(200).send({ ok: true });

    handleTelegramUpdate(db, request.body as TelegramUpdate).catch((err) => {
      console.error("[telegram] webhook handling failed:", err);
    });
  });

  app.get("/health", async () => ({ status: "ok" }));
}
