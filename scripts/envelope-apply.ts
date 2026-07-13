import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { getTransaction } from "../src/db/queries";
import { applyTransaction } from "../src/envelope/engine";

function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: npm run envelope:apply -- <transaction_id>");
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

  const result = applyTransaction(db, transaction);
  console.log("result:", result);
  console.log("transaction after:", getTransaction(db, id));
}

main();
