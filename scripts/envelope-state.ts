import "dotenv/config";
import { getDb, runMigrations } from "../src/db/schema";
import { getEnvelopeState } from "../src/envelope/engine";

function main() {
  const dbPath = process.env.DATABASE_PATH ?? "./plutus.sqlite";
  const db = getDb(dbPath);
  runMigrations(db);

  console.log(getEnvelopeState(db));
}

main();
