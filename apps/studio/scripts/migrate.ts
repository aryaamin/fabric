import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const migration = await readFile(
  new URL("../db/migrations/001_core.sql", import.meta.url),
  "utf8",
);
const statements = migration
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement && statement !== "BEGIN" && statement !== "COMMIT");
const sql = neon(connectionString);

await sql.transaction(statements.map((statement) => sql.query(statement)));
console.log("Applied Fabric core migration.");
