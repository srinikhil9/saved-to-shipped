import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const COLUMNS = new Set([
  "url",
  "author",
  "text",
  "created_at",
  "kind",
  "status",
  "summary",
  "why_you",
  "action_result_json",
  "screenshot_path",
  "error",
]);

export function openDb(dbPath = ":memory:") {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      author TEXT,
      text TEXT,
      created_at TEXT NOT NULL,
      kind TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      why_you TEXT,
      action_result_json TEXT,
      screenshot_path TEXT,
      error TEXT
    );
  `);
  return db;
}

export function createSave(db, url) {
  const created_at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO saves (url, created_at, status)
       VALUES (@url, @created_at, 'queued')`,
    )
    .run({ url, created_at });
  return getSave(db, Number(info.lastInsertRowid));
}

export function updateSave(db, id, fields) {
  const keys = Object.keys(fields).filter((key) => COLUMNS.has(key));
  if (keys.length === 0) return getSave(db, id);
  const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
  db.prepare(`UPDATE saves SET ${assignments} WHERE id = @id`).run({ ...fields, id });
  return getSave(db, id);
}

export function getSave(db, id) {
  return db.prepare("SELECT * FROM saves WHERE id = ?").get(id) || null;
}

export function findSaveByUrl(db, url) {
  return db.prepare("SELECT * FROM saves WHERE url = ? ORDER BY id DESC LIMIT 1").get(url) || null;
}

export function listSaves(db) {
  return db.prepare("SELECT * FROM saves ORDER BY created_at DESC, id DESC").all();
}

const INTERRUPTED = "This save was interrupted when the server stopped. Run it again.";

export function failStuckSaves(db) {
  const stuck = db
    .prepare(`SELECT id FROM saves WHERE status IN ('queued', 'sorting', 'acting')`)
    .all();
  for (const row of stuck) {
    updateSave(db, row.id, { status: "failed", error: INTERRUPTED });
  }
  return stuck.length;
}

export function publicSave(row) {
  if (!row) return null;
  let action = null;
  if (row.action_result_json) {
    try {
      action = JSON.parse(row.action_result_json);
    } catch {
      action = null;
    }
  }
  return {
    id: row.id,
    url: row.url,
    author: row.author,
    text: row.text,
    created_at: row.created_at,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    why_you: row.why_you,
    action_result_json: action,
    screenshot_path: row.screenshot_path,
    error: row.error,
  };
}
