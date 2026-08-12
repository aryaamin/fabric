import { readdir, readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const files = (await readdir(migrationsUrl))
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();
const sql = neon(connectionString);

for (const file of files) {
  const migration = await readFile(new URL(file, migrationsUrl), "utf8");
  const statements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement && statement !== "BEGIN" && statement !== "COMMIT");
  await sql.transaction(statements.map((statement) => sql.query(statement)));
  console.log(`Applied ${file}.`);
}
