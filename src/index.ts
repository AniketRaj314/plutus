import "dotenv/config";
import { getDb, runMigrations } from "./db/schema";
import { startPoller } from "./gmail/poller";
import { startEnvelopeCron } from "./envelope/engine";

console.log("Plutus starting...");

const dbPath = process.env.DATABASE_PATH ?? "./plutus.sqlite";
const db = getDb(dbPath);
runMigrations(db);
console.log("DB ready");

startPoller(db);
startEnvelopeCron(db);
