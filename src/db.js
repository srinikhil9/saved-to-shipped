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
  "why_you_source",
  "why_you_profile_hash",
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
      why_you_source TEXT,
      why_you_profile_hash TEXT,
      action_result_json TEXT,
      screenshot_path TEXT,
      error TEXT
    );
  `);
  const have = new Set(db.prepare("PRAGMA table_info(saves)").all().map((column) => column.name));
  if (!have.has("why_you_source")) db.exec("ALTER TABLE saves ADD COLUMN why_you_source TEXT");
  if (!have.has("why_you_profile_hash")) db.exec("ALTER TABLE saves ADD COLUMN why_you_profile_hash TEXT");
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
    .prepare(
      `SELECT id, kind, action_result_json FROM saves WHERE status IN ('queued', 'sorting', 'acting')`,
    )
    .all();
  let failed = 0;
  let restored = 0;
  for (const row of stuck) {
    if (row.kind && row.action_result_json) {
      updateSave(db, row.id, {
        status: "done",
        error: null,
        action_result_json: withoutPendingUpgrade(row.action_result_json),
      });
      restored += 1;
    } else {
      updateSave(db, row.id, { status: "failed", error: INTERRUPTED });
      failed += 1;
    }
  }
  const pending = db
    .prepare(
      `SELECT id, action_result_json FROM saves WHERE status = 'done' AND action_result_json LIKE '%"pending"%'`,
    )
    .all();
  let cleared = 0;
  for (const row of pending) {
    const next = withoutPendingUpgrade(row.action_result_json);
    if (next !== row.action_result_json) {
      updateSave(db, row.id, { action_result_json: next });
      cleared += 1;
    }
  }
  db.prepare("UPDATE saves SET why_you_source = 'template' WHERE why_you_source = 'pending'").run();
  return { failed, restored, cleared, total: stuck.length };
}

export function withoutPendingUpgrade(json) {
  if (!json) return json;
  let action;
  try {
    action = JSON.parse(json);
  } catch {
    return json;
  }
  let changed = false;
  if (action?.sorted?.upgrade === "pending") {
    action.sorted.upgrade = null;
    changed = true;
  }
  if (action?.act?.source === "pending") {
    action.act.source = "template";
    changed = true;
  }
  if (action?.act?.upgrade === "pending") {
    action.act.upgrade = null;
    changed = true;
  }
  if (!changed) return json;
  return JSON.stringify(action);
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
    why_you_source: row.why_you_source,
    why_you_profile_hash: row.why_you_profile_hash,
    action_result_json: action,
    screenshot_path: row.screenshot_path,
    error: row.error,
  };
}
