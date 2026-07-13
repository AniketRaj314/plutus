import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { checkPendingCorrelations } from "../src/enrichment/correlator";

async function main() {
  const dbPath = process.env.DATABASE_PATH ?? "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);

  await checkPendingCorrelations(db);
  console.log("done");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
