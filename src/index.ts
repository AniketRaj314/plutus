import "dotenv/config";
import Fastify from "fastify";
import { getDb, runMigrations } from "./db/schema";
import { startPoller } from "./gmail/poller";
import { registerWebhook } from "./telegram/bot";
import { registerRoutes, registerApiRoutes } from "./api/routes";
import { startCorrelator } from "./enrichment/correlator";
import { startInferenceCron } from "./agent/inference";

async function main() {
  console.log("Plutus starting...");

  const dbPath = process.env.DATABASE_PATH || "./plutus.sqlite";
  console.log(`Node version: ${process.version}`);
  console.log(`DATABASE_PATH: ${dbPath}`);

  const db = getDb(dbPath);
  runMigrations(db);
  console.log("DB ready");

  startCorrelator(db);
  startInferenceCron(db);

  const app = Fastify();
  registerRoutes(app, db);
  registerApiRoutes(app, db);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Plutus listening on port ${port}`);

  if (process.env.NODE_ENV === "production") {
    await registerWebhook();
    console.log(`Telegram webhook registered at ${process.env.WEBHOOK_URL}`);
  }

  startPoller(db);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
