import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { rolloverWeek } from "../src/envelope/engine";

function main() {
  const dbPath = process.env.DATABASE_PATH || "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);

  const result = rolloverWeek(db);
  console.log(result);
}

main();
