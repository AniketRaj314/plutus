import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { getTransaction } from "../src/db/queries";
import { attemptCorrelation } from "../src/enrichment/correlator";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: npm run correlate:force -- <transaction_id>");
    process.exit(1);
  }

  const dbPath = process.env.DATABASE_PATH || "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);

  const transaction = getTransaction(db, id);
  if (!transaction) {
    console.error(`No transaction found with id=${id}`);
    process.exit(1);
  }

  console.log("before:", transaction);
  await attemptCorrelation(db, transaction);
  console.log("after:", getTransaction(db, id));
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
