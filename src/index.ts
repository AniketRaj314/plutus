import "dotenv/config";
import Fastify from "fastify";
import { getDb, runMigrations } from "./db/schema";
import { startPoller } from "./gmail/poller";
import { startEnvelopeCron } from "./envelope/engine";
import { registerWebhook, flushPendingRebalanceMessage } from "./telegram/bot";
import { registerRoutes } from "./api/routes";

async function main() {
  console.log("Plutus starting...");

  const dbPath = process.env.DATABASE_PATH ?? "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);
  console.log("DB ready");

  const app = Fastify();
  registerRoutes(app, db);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Fastify listening on port ${port}`);

  await registerWebhook();
  await flushPendingRebalanceMessage(db);

  startPoller(db);
  startEnvelopeCron(db);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
