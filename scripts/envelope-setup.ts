import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { setupEnvelope } from "../src/envelope/engine";

function main() {
  const dbPath = process.env.DATABASE_PATH || "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);

  const monthlySpendable = process.argv[2] ? Number(process.argv[2]) : undefined;
  const salaryDay = process.argv[3] ? Number(process.argv[3]) : undefined;

  const envelope = setupEnvelope(db, { monthlySpendable, salaryDay });
  console.log(envelope);
}

main();
