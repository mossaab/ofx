#!/usr/bin/env node
// openfox-watchdog-db.cjs — metrics of the OpenFox event journal, READ-ONLY.
// Called by openfox-watchdog.sh. Output: KEY=VALUE lines on stdout.
// Environment variables: WD_DB (path to sessions.db), WD_SQLITE (path to better-sqlite3).
//
// "Focus" session = the RUNNING session if one exists, otherwise the one with the most events.
// It is the one that must be watched: the most predictive rule is the number of events
// accumulated SINCE its last snapshot (beyond that, getEventsSinceSnapshot() re-reads the whole journal).

const dbPath = process.env.WD_DB;
const sqlitePath = process.env.WD_SQLITE;

function out(k, v) {
  console.log(k + '=' + v);
}

let Database;
try {
  Database = require(sqlitePath);
} catch (e) {
  out('DB_ERROR', 'sqlite module not found: ' + e.message);
  process.exit(0);
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (e) {
  out('DB_ERROR', 'cannot open: ' + e.message);
  process.exit(0);
}

try {
  db.pragma('query_only = true');

  const total = db.prepare('SELECT COUNT(*) n FROM events').get();
  out('DB_TOTAL_EVENTS', total ? total.n : 0);

  const running = db.prepare('SELECT COUNT(*) n FROM sessions WHERE is_running = 1').get();
  out('DB_RUNNING_SESSIONS', running ? running.n : 0);

  // --- focus session: the running one, otherwise the largest by event count ---
  let focus = db
    .prepare("SELECT id, title, is_running FROM sessions WHERE is_running = 1 ORDER BY updated_at DESC LIMIT 1")
    .get();
  if (!focus) {
    focus = db
      .prepare(
        'SELECT s.id, s.title, s.is_running FROM sessions s JOIN events e ON e.session_id = s.id GROUP BY s.id ORDER BY COUNT(e.id) DESC LIMIT 1'
      )
      .get();
  }

  if (focus) {
    out('DB_FOCUS_ID', focus.id);
    out('DB_FOCUS_TITLE', String(focus.title ?? '').replace(/[=\n\r]/g, ' ').slice(0, 60));
    out('DB_FOCUS_RUNNING', focus.is_running ? 1 : 0);

    const ev = db
      .prepare('SELECT COUNT(*) n, SUM(LENGTH(payload)) b FROM events WHERE session_id = ?')
      .get(focus.id);
    out('DB_FOCUS_EVENTS', ev ? ev.n : 0);
    out('DB_FOCUS_MB', ev && ev.b ? (ev.b / 1048576).toFixed(2) : 0);

    const snap = db
      .prepare(
        "SELECT COUNT(*) n, MAX(seq) mx FROM events WHERE session_id = ? AND event_type = 'turn.snapshot'"
      )
      .get(focus.id);
    out('DB_FOCUS_SNAPSHOTS', snap ? snap.n : 0);

    const mx = db.prepare('SELECT MAX(seq) mx FROM events WHERE session_id = ?').get(focus.id);
    const snapSeq = snap && snap.mx ? snap.mx : 0;
    const lag = mx && mx.mx ? Math.max(0, mx.mx - snapSeq) : 0;
    out('DB_FOCUS_LAG', lag);

    const lagBytes = db
      .prepare('SELECT COUNT(*) n, SUM(LENGTH(payload)) b FROM events WHERE session_id = ? AND seq > ?')
      .get(focus.id, snapSeq);
    out('DB_FOCUS_LAG_MB', lagBytes && lagBytes.b ? (lagBytes.b / 1048576).toFixed(2) : 0);
  }

  // --- worst lag across ALL sessions, measured in BYTES ---
  // This is THE cost metric: getEventsSinceSnapshot() re-reads everything after the last
  // snapshot. 20 MB starts to cost, 953 MB cost 6.9 s per state load.
  try {
    const worst = db
      .prepare(
        `SELECT e.session_id AS id, COUNT(*) AS n, SUM(LENGTH(e.payload)) AS b
           FROM events e
           LEFT JOIN (SELECT session_id, MAX(seq) AS mx FROM events WHERE event_type = 'turn.snapshot' GROUP BY session_id) s
             ON s.session_id = e.session_id
          WHERE e.seq > COALESCE(s.mx, 0)
          GROUP BY e.session_id
          ORDER BY b DESC
          LIMIT 1`
      )
      .get();
    out('DB_MAX_LAG', worst ? worst.n : 0);
    out('DB_MAX_LAG_MB', worst && worst.b ? (worst.b / 1048576).toFixed(2) : 0);
    out('DB_MAX_LAG_SESSION', worst ? worst.id : '-');
  } catch (e) {
    out('DB_MAX_LAG', '-');
    out('DB_MAX_LAG_MB', '-');
    out('DB_MAX_LAG_SESSION', '-');
  }

  // --- biggest session, for info ---
  const big = db
    .prepare(
      'SELECT session_id, COUNT(*) n, SUM(LENGTH(payload)) b FROM events GROUP BY session_id ORDER BY b DESC LIMIT 1'
    )
    .get();
  out('DB_BIGGEST_ID', big ? big.session_id : '-');
  out('DB_BIGGEST_EVENTS', big ? big.n : 0);
  out('DB_BIGGEST_MB', big && big.b ? (big.b / 1048576).toFixed(1) : 0);

  const last = db.prepare('SELECT MAX(timestamp) t FROM events').get();
  out('DB_LAST_EVENT_AGE_S', last && last.t ? Math.round(Date.now() / 1000 - last.t / 1000) : -1);

  const ps = db.pragma('page_size', { simple: true });
  const pc = db.pragma('page_count', { simple: true });
  const fl = db.pragma('freelist_count', { simple: true });
  out('DB_LIVE_MB', (((pc - fl) * ps) / 1048576).toFixed(1));
  out('DB_RECLAIMABLE_MB', ((fl * ps) / 1048576).toFixed(1));
} catch (e) {
  out('DB_ERROR', e.message.replace(/\s+/g, ' ').slice(0, 160));
} finally {
  try {
    db.close();
  } catch {}
}
