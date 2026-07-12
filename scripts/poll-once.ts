import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { pollOnce } from "../src/gmail/poller";

async function main() {
  const dbPath = process.env.DATABASE_PATH ?? "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);
  await pollOnce(db);
}

main();
