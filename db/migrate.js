/**
 * migrate.js
 * Lightweight migration runner — applies any db/migration_*.sql that hasn't run
 * yet, in filename order, and records it in schema_migrations. Runs on server
 * boot (see server.js), so deploying the code applies pending migrations.
 *
 * All migrations are written to be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS), so a retry after a partial failure is safe. A failed migration is NOT
 * recorded and does NOT crash the API — it's logged loudly and retried next boot,
 * leaving already-working endpoints up.
 */

const fs = require("fs");
const path = require("path");
const db = require("./index");

async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^migration_.*\.sql$/.test(f))
    .sort(); // migration_002 < migration_003 < ... lexical order matches numbering

  for (const filename of files) {
    const { rows } = await db.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename]
    );
    if (rows.length) continue; // already applied

    const sql = fs.readFileSync(path.join(dir, filename), "utf8");
    console.log(`[migrate] applying ${filename}`);
    try {
      // node-postgres runs all statements in a single query() call (simple
      // protocol, no params). Our migration files are plain multi-statement SQL.
      await db.query(sql);
      await db.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
        [filename]
      );
      console.log(`[migrate] ✓ ${filename}`);
    } catch (err) {
      // Don't take the whole API down for a migration error — log and move on.
      // It stays unrecorded and retries on the next boot.
      console.error(`[migrate] ✗ ${filename} failed: ${err.message}`);
    }
  }

  console.log("[migrate] up to date");
}

module.exports = { runMigrations };
