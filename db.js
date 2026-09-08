const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'call_tracking.db'));

db.pragma('journal_mode = WAL');

// Table of numbers: which Telnyx number is linked to which campaign/sender
db.exec(`
  CREATE TABLE IF NOT EXISTS numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE NOT NULL,
    telnyx_number_id TEXT,
    campaign_id TEXT NOT NULL,
    sender_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);


// Call table: log of each incoming call
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_control_id TEXT,
    call_leg_id TEXT,
    tracking_number TEXT NOT NULL,
    from_number TEXT,
    campaign_id TEXT,
    status TEXT DEFAULT 'ringing',
    started_at TEXT DEFAULT (datetime('now')),
    answered_at TEXT,
    ended_at TEXT,
    duration_seconds INTEGER,
    recording_url TEXT,
    transcript TEXT,
    ai_summary TEXT
  )
`);

module.exports = db;