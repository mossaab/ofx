#!/usr/bin/env node
// openfox-session-live.cjs — live dashboard of OpenFox sessions.
//
// One screen: the sessions that are running right now (step, elapsed time, token
// speed, tokens used, context occupancy, snapshot lag) and, when fewer than --min
// are active, the most recently finished sessions that fill the gap.
//
// READ-ONLY: the database is opened readonly + query_only, /proc is read for the
// server CPU/RSS, nothing is written anywhere. The connection is opened AND CLOSED
// on every sample, so a dashboard left open for hours never pins a WAL read
// snapshot and never delays a checkpoint.
//
// WHAT IS DELIBERATELY *NOT* DONE ON EVERY SAMPLE (the whole point):
//   - no extra sample to animate a blocked session: the blink redraws the frame
//     from the model already in memory (see PENDING_TYPES below);
//   - no SUM(LENGTH(payload)) over the table: lag is measured once per session,
//     then updated incrementally with the events that arrived since the previous
//     sample (full resync every RESYNC_EVERY samples, in case of a gap);
//   - no turn.snapshot payload is parsed per sample (they are 0.5-1 MB each); the
//     last snapshot is read once per FINISHED session to recover its final context;
//   - chat.done payloads are parsed incrementally (new turns only) and cached;
//   - every query filters by session_id first, so it uses idx_events_session_type_seq.
// Measured on a 1.4 GB / 120k-event database, on a host with 2 000 processes:
// 2-6 ms of CPU per sample with nothing to show, 6-10 ms with five sessions
// (the /proc scan is refreshed every 10 s, not on every sample).
//
// WHAT THE DATA CAN AND CANNOT SHOW:
//   sessions.total_tokens_used / total_tool_calls / iteration_count are 0 on every
//   session (openfox does not maintain them), and cleanupOldEvents() purges the
//   journal of a finished session. Token totals of finished sessions are therefore
//   NOT recoverable and are shown as "-". What does survive: the workflow step, the
//   duration, the final context size (turn.snapshot.contextState) and the outcome.
//   Acceptance criteria and review findings are metadata.set events (keys "criteria"
//   and "review_findings"), rewritten as a whole list on each change and kept by the
//   purge, so their per-item progress is visible for running and finished sessions.
//
// USAGE
//   openfox-session-live.cjs                     # every 2 s until Ctrl+C
//   openfox-session-live.cjs --interval 1 --min 0
//   openfox-session-live.cjs --samples 5         # stops after 5 samples (for a log)
//   openfox-session-live.cjs --once              # one screen, then exit
//   openfox-session-live.cjs --items             # expand criteria / findings
//
// When stdout is not a TTY (redirected to a file), the colors are dropped, no
// escape sequence is emitted, one timestamped block is printed per sample and the
// default is a single sample.
//
// EXIT CODES: 0 success (also on Ctrl+C) | 1 usage / missing database | 2 failure

'use strict';

const fs = require('fs');
const path = require('path');

const SQLITE_MODULE =
  process.env.OPENFOX_WD_SQLITE || '/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3';
const DB_PATH =
  process.env.OPENFOX_DB_PATH || path.join(process.env.HOME || '.', '.local/share/openfox/sessions.db');

// Mirrors EventStore: is_running = 1 with no event for 5 minutes is a ghost
// (initEventStore() forces is_running = 0 on every session at startup).
const STALE_MS = 5 * 60 * 1000;

// Thresholds aligned with openfox-watchdog.sh / ofx.cjs (single source of truth).
const LAG_MB_WARN = Number(process.env.OPENFOX_WD_LAG_MB_WARN || 20);
const LAG_MB_CRIT = Number(process.env.OPENFOX_WD_LAG_MB_CRIT || 100);

// A session blocked on a human: the very last event says so. OpenFox journals a
// question as chat.ask_user immediately followed by a chat.done whose reason is
// "waiting_for_user" (same millisecond, e.g. seq 11617 then 11618 in a real
// journal), so testing the event type alone would never see a question: the
// chat.done reason is part of the rule, not a fallback.
const PENDING_TYPES = {
  'chat.ask_user': 'question',
  'path.confirmation_pending': 'access',
};

// Acceptance criteria and review findings are not dedicated event types: OpenFox
// stores them in metadata.set with these two keys, rewriting the whole list every
// time one item changes its status. Their vocabulary, observed in 2.0.161:
//   criteria        pending -> completed (implemented) -> passed | failed
//   review_findings open    -> resolved | dismissed
const CHECK_KEYS = ['criteria', 'review_findings'];
const CHECK_STATUS = {
  pending: { glyph: '\u00b7', color: 'd', word: 'pending' },
  completed: { glyph: '\u25d0', color: 'c', word: 'in progress' },
  passed: { glyph: '\u2713', color: 'g', word: 'passed' },
  failed: { glyph: '\u2717', color: 'r', word: 'failed' },
  open: { glyph: '\u25cb', color: 'y', word: 'open' },
  resolved: { glyph: '\u2713', color: 'g', word: 'resolved' },
  dismissed: { glyph: '\u2013', color: 'd', word: 'dismissed' },
};
const CHECK_TERMINAL = ['passed', 'failed', 'resolved', 'dismissed'];
const MAX_ITEMS = 14; // per list, then "… +N more"

// Event types whose last occurrence is cheap to read (small payloads only).
const DETAIL_TYPES = [
  'context.state',
  'phase.changed',
  'running.changed',
  'chat.done',
  'chat.error',
  'chat.ask_user',
  'path.confirmation_pending',
];

const RESYNC_EVERY = 30; // samples between two full lag recomputations
const SPARK_LEN = 24; // samples kept for the speed sparkline
const MAX_WIDTH = 140;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { interval: 2, min: 5, samples: 0, color: true, items: false };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--interval') opt.interval = Number(argv[++i]);
  else if (a === '--min') opt.min = Number(argv[++i]);
  else if (a === '--samples') opt.samples = Number(argv[++i]);
  else if (a === '--once') opt.samples = 1;
  else if (a === '--items') opt.items = true;
  else if (a === '--no-color') opt.color = false;
  else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  } else {
    console.error(`unknown option: ${a}`);
    console.error(
      'usage: openfox-session-live.cjs [--interval N] [--min N] [--samples N] [--once] [--items] [--no-color]'
    );
    process.exit(1);
  }
}

if (!Number.isFinite(opt.interval) || opt.interval < 1) {
  console.error('--interval must be a number of seconds >= 1');
  process.exit(1);
}
if (!Number.isFinite(opt.min) || opt.min < 0) {
  console.error('--min must be a number >= 0');
  process.exit(1);
}
if (!Number.isFinite(opt.samples) || opt.samples < 0) {
  console.error('--samples must be a number >= 0');
  process.exit(1);
}

const IS_TTY = !!process.stdout.isTTY;
// A redirected run is a snapshot unless --samples says otherwise: no infinite log.
if (!IS_TTY && !opt.samples) opt.samples = 1;

const useColor = opt.color && IS_TTY && !process.env.NO_COLOR;
const C = useColor
  ? { r: '\u001b[31m', g: '\u001b[32m', y: '\u001b[33m', c: '\u001b[36m', b: '\u001b[1m', d: '\u001b[2m', x: '\u001b[0m' }
  : { r: '', g: '', y: '', c: '', b: '', d: '', x: '' };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const strip = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const pad = (s, n) => {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
};
const padL = (s, n) => {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
};
const trunc = (s, n) => {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '\u2026';
};

// left (already colored) + filler + right, total width = width
function rowOf(left, right, width) {
  const gap = Math.max(1, width - strip(left).length - strip(right).length);
  return left + ' '.repeat(gap) + right;
}

function fmtBytes(n) {
  n = Number(n || 0);
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
}

function fmtK(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  return Math.floor(h / 24) + 'd ' + String(h % 24).padStart(2, '0') + 'h';
}

function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + 's ago';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function bar(ratio, width) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  const n = Math.round(r * width);
  return '\u2588'.repeat(n) + '\u2591'.repeat(Math.max(0, width - n));
}

const SPARK = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
function sparkline(values) {
  if (!values.length) return '';
  const v = values.slice(-SPARK_LEN);
  const mx = Math.max(...v, 0.001);
  return v.map((x) => SPARK[Math.min(7, Math.floor((x / mx) * 7.99))]).join('');
}

// Date#toLocaleTimeString costs ~1 ms per call, which matters in a 2 s loop.
const clock = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

function printHelp() {
  console.log(`
  openfox-session-live — live dashboard of OpenFox sessions

  USAGE
    openfox-session-live.cjs [--interval N] [--min N] [--samples N] [--once] [--items] [--no-color]

  OPTIONS
    --interval N   seconds between two samples (default 2, minimum 1)
    --min N        fill up to N active sessions with the most recently finished
                   ones (default 5, 0 disables the historical block)
    --samples N    stop after N samples (0 = until Ctrl+C)
    --once         one sample, then exit
    --items        list the acceptance criteria and review findings, one per
                   line, instead of only their progress summary
    --no-color     disable colors (also honors NO_COLOR and a non-TTY stdout)

  A session blocked on a human is listed first and flagged in red: a question
  (chat.ask_user, or the chat.done "waiting_for_user" that follows it) and an
  access request (path.confirmation_pending) both turn the badge into a blinking
  WAITING, and the second line says what is awaited: "waiting 12s · question" or
  "waiting 12s · access". The glyph pulses during the first minute, then the card
  stays red and static. The blink redraws the frame already in memory, it never
  costs an extra sample, and it is disabled when stdout is not a color terminal.

  READ-ONLY. The database is opened readonly + query_only and closed again after
  every sample. Nothing is written, no WAL read snapshot is held.

  EXIT CODES  0 success (also on Ctrl+C) | 1 usage / missing database | 2 failure
`);
}

// ---------------------------------------------------------------------------
// Terminal state (cursor hidden while the frame is redrawn)
// ---------------------------------------------------------------------------
let cursorHidden = false;
function hideCursor() {
  if (IS_TTY && !cursorHidden) {
    process.stdout.write('\u001b[?25l');
    cursorHidden = true;
  }
}
function showCursor() {
  if (cursorHidden) {
    process.stdout.write('\u001b[?25h');
    cursorHidden = false;
  }
}
process.on('exit', showCursor);
process.on('SIGINT', () => {
  showCursor();
  process.stdout.write('\n');
  process.exit(0);
});
// `ofx live | head` must not crash on EPIPE.
process.stdout.on('error', () => {
  showCursor();
  process.exit(0);
});

function fail(msg, code) {
  showCursor();
  console.error('  \u2717 ' + msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Database (read-only, closed after every sample)
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) fail(`database not found: ${DB_PATH}`, 1);
  let Database;
  try {
    Database = require(SQLITE_MODULE);
  } catch (e) {
    fail(`better-sqlite3 module not found (${SQLITE_MODULE})\n    ${e.message}`, 1);
  }
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    fail(`cannot open: ${e.message}`, 1);
  }
  db.pragma('query_only = true');
  return db;
}

// Per-session memo, kept across samples: token totals, lag accounting, sparkline.
const cache = new Map();
function memo(id) {
  let m = cache.get(id);
  if (!m) {
    m = {
      lastSeq: null, // max event seq seen at the previous sample
      prevTs: null, // timestamp of the previous sample (live-speed window)
      lagBytes: null, // bytes after the last turn.snapshot
      lagEvents: 0,
      snapSeq: null,
      rateAnchor: null, // { ts, bytes } for the MB/min estimate
      lagRate: null,
      tok: null, // incremental chat.done accumulator
      spark: [],
      ctxCache: null, // { seq, cur, max } recovered from a turn.snapshot
      metaSeq: null, // max seq of metadata.set seen (criteria / review findings)
      checks: null, // parsed acceptance criteria + review findings
    };
    cache.set(id, m);
  }
  return m;
}

// Last event of every session: seq, timestamp and type, in two set-based queries.
function lastEvents(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT session_id, MAX(seq) AS mx, MAX(timestamp) AS ts
         FROM events WHERE session_id IN (${ph}) GROUP BY session_id`
    )
    .all(...ids);
  for (const r of rows) out.set(r.session_id, { mx: r.mx, ts: r.ts, type: null });
  const pairs = [...out].map(([id, v]) => [id, v.mx]);
  if (pairs.length) {
    const cond = pairs.map(() => '(session_id = ? AND seq = ?)').join(' OR ');
    const last = db.prepare(`SELECT session_id, seq, timestamp, event_type FROM events WHERE ${cond}`).all(...pairs.flat());
    for (const r of last) {
      const e = out.get(r.session_id);
      e.type = r.event_type;
      e.ts = r.timestamp;
      e.mx = r.seq;
    }
  }
  return out;
}

// Why the last event blocks the session on a human: null | 'question' | 'access'.
// Single source of truth for the sample() classification and the card badge, so
// the two can never disagree. `doneReason` is only read when the last event is a
// chat.done (the question case); path.confirmation_responded clears the wait.
function pendingOf(le, doneReason) {
  if (!le) return null;
  const direct = PENDING_TYPES[le.type];
  if (direct) return direct;
  if (le.type === 'chat.done' && doneReason === 'waiting_for_user') return 'question';
  return null;
}

// Reason of the last event, only for the sessions whose last event is a chat.done.
// json_extract keeps it to a few bytes, and the query is set-based: no payload is
// read for a session that is busy generating.
function lastDoneReasons(db, last) {
  const out = new Map();
  const pairs = [];
  for (const [id, v] of last) if (v.type === 'chat.done') pairs.push([id, v.mx]);
  if (!pairs.length) return out;
  const cond = pairs.map(() => '(session_id = ? AND seq = ?)').join(' OR ');
  const rows = db
    .prepare(`SELECT session_id, json_extract(payload, '$.reason') AS reason FROM events WHERE ${cond}`)
    .all(...pairs.flat());
  for (const r of rows) out.set(r.session_id, r.reason);
  return out;
}

// Last occurrence of each DETAIL_TYPE per session, in one window-function query.
// turn.snapshot is excluded on purpose: its payload is huge, its timestamp comes
// from lastSnapshots() instead.
function lastDetails(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const th = DETAIL_TYPES.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT session_id, event_type, seq, timestamp, payload FROM (
         SELECT session_id, event_type, seq, timestamp, payload,
                ROW_NUMBER() OVER (PARTITION BY session_id, event_type ORDER BY seq DESC) AS rn
           FROM events
          WHERE session_id IN (${ph}) AND event_type IN (${th})
       ) WHERE rn = 1`
    )
    .all(...ids, ...DETAIL_TYPES);
  for (const r of rows) {
    let m = out.get(r.session_id);
    if (!m) {
      m = new Map();
      out.set(r.session_id, m);
    }
    m.set(r.event_type, r);
  }
  return out;
}

// seq + timestamp of the last turn.snapshot per session (no payload).
function lastSnapshots(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.session_id, e.seq, e.timestamp
         FROM events e
         JOIN (SELECT session_id AS sid, MAX(seq) AS mx FROM events
                WHERE session_id IN (${ph}) AND event_type = 'turn.snapshot'
                GROUP BY session_id) s
           ON s.sid = e.session_id AND s.mx = e.seq`
    )
    .all(...ids);
  for (const r of rows) out.set(r.session_id, { seq: r.seq, ts: r.timestamp });
  return out;
}

// Current workflow execution per session (small table, indexed by session_id).
function lastWorkflows(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT session_id, workflow_name, status, current_step_name, updated_at
           FROM workflow_executions WHERE session_id IN (${ph}) ORDER BY updated_at DESC`
      )
      .all(...ids);
  } catch {
    return out; // older OpenFox without workflow_executions
  }
  for (const r of rows) if (!out.has(r.session_id)) out.set(r.session_id, r);
  return out;
}

// Cumulative and "last chat" token stats, parsed incrementally.
// A new chat.done only appears at the end of an LLM cycle, so the merge is rare.
function tokensOf(db, id, maxSeq) {
  const m = memo(id);
  if (!m.tok) m.tok = { parsedSeq: 0, in: 0, cached: 0, out: 0, genSec: 0, lastSpeed: null, lastIn: 0, lastOut: 0, lastCached: 0, reason: null };
  const t = m.tok;
  // seq is monotonic: if no event arrived since the last scan, no chat.done can
  // have appeared either. This keeps an idle dashboard at one query per session.
  if (maxSeq && m.tokCheckedSeq && maxSeq <= m.tokCheckedSeq) return t;
  const rows = db
    .prepare(
      `SELECT seq, payload FROM events
        WHERE session_id = ? AND event_type = 'chat.done' AND seq > ? ORDER BY seq`
    )
    .all(id, t.parsedSeq);
  for (const r of rows) {
    t.parsedSeq = r.seq;
    let obj;
    try {
      obj = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (!obj) continue;
    if (obj.reason) t.reason = obj.reason;
    // A chat.done can be a stub ({"reason":"error"} without stats): keep the
    // reason, skip the (absent) token accounting.
    const st = obj.stats;
    if (!st) continue;
    const pin = Number(st.prefillTokens) || 0;
    const out = Number(st.generationTokens) || 0;
    const cached = Number(st.cachedPromptTokens) || 0;
    t.in += pin;
    t.out += out;
    t.cached += cached;
    if (out > 0 && Number(st.generationSpeed) > 0) t.genSec += out / Number(st.generationSpeed);
    const calls = Array.isArray(st.llmCalls) ? st.llmCalls : [];
    const lastCall = calls.length ? calls[calls.length - 1] : null;
    const speed = Number(lastCall && lastCall.generationSpeed) || Number(st.generationSpeed) || null;
    t.lastSpeed = speed;
    t.lastIn = pin;
    t.lastOut = out;
    t.lastCached = cached;
  }
  m.tokCheckedSeq = maxSeq || t.parsedSeq;
  return t;
}

// Final context size of a FINISHED session, recovered from its last snapshot.
// json_extract avoids materializing a 0.5-1 MB object; the result is cached by seq.
function snapshotContext(db, id, snapSeq) {
  if (!snapSeq) return null;
  const m = memo(id);
  if (m.ctxCache && m.ctxCache.seq === snapSeq) return m.ctxCache;
  let r;
  try {
    r = db
      .prepare(
        `SELECT seq, json_extract(payload, '$.contextState.currentTokens') AS cur,
                json_extract(payload, '$.contextState.maxTokens') AS mx
           FROM events WHERE session_id = ? AND event_type = 'turn.snapshot'
          ORDER BY seq DESC LIMIT 1`
      )
      .get(id);
  } catch {
    return null;
  }
  if (!r) return null;
  m.ctxCache = { seq: r.seq, cur: Number(r.cur) || 0, max: Number(r.mx) || 0 };
  return m.ctxCache;
}

// Maximum seq of metadata.set per session: index-only, no payload is read.
function lastMetadata(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  for (const r of db
    .prepare(
      `SELECT session_id, MAX(seq) AS mx FROM events
        WHERE session_id IN (${ph}) AND event_type = 'metadata.set' GROUP BY session_id`
    )
    .all(...ids)) {
    out.set(r.session_id, r.mx);
  }
  return out;
}

// Acceptance criteria and review findings, re-read only when a metadata.set was
// written since the previous sample (the whole list is rewritten each time).
function checksOf(db, id, metaSeq) {
  const m = memo(id);
  if (m.checks && m.metaSeq === metaSeq) return m.checks;
  m.metaSeq = metaSeq || 0;
  const out = {};
  if (metaSeq) {
    const rows = db
      .prepare(
        `SELECT payload FROM (
           SELECT payload, ROW_NUMBER() OVER (
                    PARTITION BY json_extract(payload, '$.key') ORDER BY seq DESC) AS rn
             FROM events WHERE session_id = ? AND event_type = 'metadata.set'
         ) WHERE rn = 1`
      )
      .all(id);
    for (const r of rows) {
      const list = parseCheckList(r.payload);
      if (list) out[list.key] = list;
    }
  }
  m.checks = out;
  return out;
}

function parseCheckList(payload) {
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  const key = String((obj && obj.key) || '');
  if (!CHECK_KEYS.includes(key)) return null;
  const entries = Array.isArray(obj && obj.entries) ? obj.entries : [];
  if (!entries.length) return null;
  const items = entries.map((e) => ({
    id: String(e && e.id != null ? e.id : '?'),
    description: String((e && e.description) || '')
      .replace(/\s+/g, ' ')
      .trim(),
    status: String((e && e.status) || '?'),
  }));
  const counts = {};
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  const done = CHECK_TERMINAL.reduce((a, st) => a + (counts[st] || 0), 0);
  return { key, items, counts, total: items.length, done };
}

// One sample: returns the model the renderer needs. Mutates the per-session memo.
function sample(state) {
  const db = openDb();
  const now = Date.now();
  state.tick++;

  try {
    // --- which sessions are running -------------------------------------
    const running = db
      .prepare(
        `SELECT id, title, created_at, updated_at, provider_model
           FROM sessions WHERE is_running = 1 ORDER BY updated_at DESC`
      )
      .all();

    const lastRunning = lastEvents(db, running.map((s) => s.id));
    const doneReasons = lastDoneReasons(db, lastRunning);
    const active = [];
    const stalled = [];
    for (const s of running) {
      const le = lastRunning.get(s.id) || null;
      const idleMs = le ? now - le.ts : Infinity;
      // A session that asked a question is WAITING, not a ghost: the turn is
      // blocked on a human, which is exactly what the operator needs to see.
      const pending = pendingOf(le, doneReasons.get(s.id));
      const rec = { ...s, le, idleMs, pending };
      if (pending) {
        rec.live = 'waiting';
        active.push(rec);
      } else if (idleMs > STALE_MS) {
        rec.live = 'stalled';
        stalled.push(rec);
      } else {
        rec.live = 'running';
        active.push(rec);
      }
    }

    // --- fill up to --min with the most recently finished sessions ------
    // message_count > 0 skips the sessions created and never used (they have no
    // step, no context and no duration worth showing).
    const need = Math.max(0, opt.min - active.length);
    const recent = need
      ? db
          .prepare(
            `SELECT id, title, created_at, updated_at, provider_model
               FROM sessions WHERE is_running = 0 AND message_count > 0
              ORDER BY updated_at DESC LIMIT ?`
          )
          .all(need)
      : [];

    const shownIds = [...running, ...recent].map((s) => s.id);
    const last = lastEvents(db, shownIds);
    const details = lastDetails(db, shownIds);
    const snapshots = lastSnapshots(db, shownIds);
    const workflows = lastWorkflows(db, shownIds);
    const meta = lastMetadata(db, shownIds);
    const shared = { now, last, details, snapshots, workflows, meta, tick: state.tick };

    // A finished session whose max seq moved is not finished any more: reset memos
    // that would otherwise keep a stale token total.
    const rows = [];
    for (const s of active) rows.push(buildSession(db, s, shared, 'active'));
    for (const s of recent) rows.push(buildSession(db, s, shared, 'history'));
    for (const s of stalled) rows.push(buildSession(db, s, shared, 'active'));

    return {
      now,
      width: Math.max(60, Math.min(Number(process.stdout.columns) || 100, MAX_WIDTH)),
      interval: opt.interval,
      // A blocked session is the only thing that needs a human: it goes first.
      active: rows
        .filter((r) => r.kind === 'active' && r.live !== 'stalled')
        .sort((a, b) => (a.live === 'waiting' ? 0 : 1) - (b.live === 'waiting' ? 0 : 1)),
      stalled: rows.filter((r) => r.live === 'stalled'),
      history: rows.filter((r) => r.kind === 'history'),
      db: statOr(DB_PATH, 0),
      wal: statOr(DB_PATH + '-wal', 0),
      server: readServer(),
    };
  } finally {
    db.close();
  }
}

function statOr(p, dflt) {
  try {
    return fs.statSync(p).size;
  } catch {
    return dflt;
  }
}

// Server RSS + CPU% (delta of /proc jiffies between two refreshes).
// Scanning /proc costs ~8 ms on a host with 2 000 processes, which would dominate
// the sample: the metrics are refreshed at most every SERVER_REFRESH_MS and the
// CPU% is the average over that window.
const SERVER_REFRESH_MS = 10000;
let serverPrev = { pid: null, ticks: 0, ts: 0 };
let serverCache = { at: 0, value: null };

function readServer() {
  const now = Date.now();
  if (serverCache.value && now - serverCache.at < SERVER_REFRESH_MS) return serverCache.value;

  let best = null;
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return { pid: null, rss: 0, cpu: null };
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes('openfox')) continue;
    let rss = 0;
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)/.exec(st);
      if (m) rss = Number(m[1]) * 1024;
    } catch {
      continue;
    }
    if (!best || rss > best.rss) best = { pid: Number(pid), rss, ticks: cpuTicks(pid) };
  }

  let value;
  if (!best) {
    value = { pid: null, rss: 0, cpu: null };
  } else {
    let cpu = null;
    if (serverPrev.pid === best.pid && serverPrev.ts && best.ticks != null && serverPrev.ticks != null) {
      const dt = (now - serverPrev.ts) / 1000;
      if (dt > 0) cpu = Math.max(0, ((best.ticks - serverPrev.ticks) / 100 / dt) * 100);
    }
    serverPrev = { pid: best.pid, ticks: best.ticks, ts: now };
    value = { pid: best.pid, rss: best.rss, cpu };
  }
  serverCache = { at: now, value };
  return value;
}

function cpuTicks(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-session model
// ---------------------------------------------------------------------------
function buildSession(db, s, shared, kind) {
  const m = memo(s.id);
  // A session that comes back to life must not reuse accounting from its previous
  // run: reset the incremental anchors and recompute lag from the snapshot.
  if (kind === 'active' && m.lastKind !== 'active') {
    m.lastSeq = null;
    m.lagBytes = null;
    m.rateAnchor = null;
    m.lagRate = null;
    m.spark = [];
  }
  m.lastKind = kind;
  const d = shared.details.get(s.id) || new Map();
  const wf = shared.workflows.get(s.id) || null;
  const snap = shared.snapshots.get(s.id) || null;
  const le = shared.last.get(s.id) || s.le || null;

  const json = (type) => {
    const r = d.get(type);
    if (!r) return null;
    try {
      return JSON.parse(r.payload);
    } catch {
      return null;
    }
  };

  const phaseObj = json('phase.changed');
  const ctxObj = json('context.state');
  let ctx = ctxObj && Number(ctxObj.currentTokens) >= 0
    ? { cur: Number(ctxObj.currentTokens) || 0, max: Number(ctxObj.maxTokens) || 0, danger: !!ctxObj.dangerZone }
    : null;

  // Step: workflow execution, then the agent phase, then the mode.
  let step = null;
  if (wf) {
    step = wf.workflow_name ? `${wf.workflow_name} \u203a ${wf.current_step_name || '?'}` : wf.current_step_name;
  } else if (phaseObj && phaseObj.phase) {
    step = phaseObj.phase;
  }

  const duration = s.created_at && s.updated_at ? Date.parse(s.updated_at) - Date.parse(s.created_at) : null;
  const idleMs = le ? shared.now - le.ts : null;

  const base = {
    kind,
    id: s.id,
    short: String(s.id).slice(0, 8),
    title: s.title || '(untitled)',
    model: s.provider_model || '-',
    step,
    phase: phaseObj ? phaseObj.phase : null,
    duration,
    idleMs,
    // Timestamp of the last event: the "waiting Ns" counter is recomputed from
    // it on every redraw, so it keeps counting between two samples.
    pendingSince: le ? le.ts : null,
    ctx,
    checks: checksOf(db, s.id, shared.meta.get(s.id) || 0),
    live: kind === 'history' ? 'finished' : null,
  };

  if (kind === 'history') {
    const t = tokensOf(db, s.id, le ? le.mx : 0);
    Object.assign(base, {
      live: 'finished',
      // Final context: context.state survives the purge; otherwise the last
      // snapshot is read once (cheap enough for a handful of finished sessions).
      ctx: ctx || snapshotContext(db, s.id, snap ? snap.seq : null),
      tokOut: t.out || null,
      tokIn: t.in || null,
      tokCached: t.cached || null,
      speed: t.genSec > 0 ? t.out / t.genSec : null,
      outcome:
        t.reason === 'error'
          ? 'error'
          : t.reason === 'waiting_for_user'
            ? 'waiting_for_user'
            : (wf && wf.status) || null,
      endedMs: idleMs,
    });
    return base;
  }

  // --- active ------------------------------------------------------------
  const turnStart = Math.max(
    Date.parse(s.created_at) || 0,
    (snap && snap.ts) || 0,
    (d.get('chat.done') || {}).timestamp || 0,
    (d.get('running.changed') || {}).timestamp || 0,
    (d.get('chat.error') || {}).timestamp || 0
  );
  const t = tokensOf(db, s.id, le ? le.mx : 0);
  // sample() is the only place that decides whether a session is blocked (one
  // helper, one rule); buildSession only renders that verdict.
  const pending = s.pending || null;

  const prevSeq = m.lastSeq || 0;
  const dtSec = m.prevTs ? (shared.now - m.prevTs) / 1000 : 0;

  // Live generation speed: thinking/delta events are emitted ~1 per token, which
  // matches the generationSpeed reported by the provider (verified on a real
  // session: 2 300 deltas/min = 38 tok/s for a reported 43.5 tok/s).
  let liveSpeed = null;
  if (prevSeq && le && le.mx > prevSeq && dtSec > 0) {
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM events
            WHERE session_id = ? AND seq > ? AND event_type IN ('message.thinking','message.delta')`
        )
        .get(s.id, prevSeq);
      liveSpeed = r.n / dtSec;
    } catch {
      liveSpeed = null;
    }
  }
  if (liveSpeed != null) {
    m.spark.push(liveSpeed);
    if (m.spark.length > SPARK_LEN * 2) m.spark = m.spark.slice(-SPARK_LEN);
  }

  // Snapshot lag, measured once then kept up to date incrementally.
  const snapSeq = snap ? snap.seq : 0;
  if (m.snapSeq !== snapSeq || m.lagBytes == null) {
    m.snapSeq = snapSeq;
    m.lagBytes = sumLag(db, s.id, snapSeq);
    m.lagEvents = countLag(db, s.id, snapSeq);
    m.rateAnchor = { ts: shared.now, bytes: m.lagBytes };
    m.lagRate = null;
  } else if (le && le.mx > prevSeq) {
    const inc = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b
           FROM events WHERE session_id = ? AND seq > ?`
      )
      .get(s.id, prevSeq);
    m.lagBytes += inc.b;
    m.lagEvents += inc.n;
  }
  // Resync now and then: an incremental sum drifts if a sample is missed.
  if (shared.tick % RESYNC_EVERY === 0) {
    m.lagBytes = sumLag(db, s.id, snapSeq);
    m.lagEvents = countLag(db, s.id, snapSeq);
  }
  // MB/min over windows of at least 10 s (a single 2 s sample is too noisy).
  if (m.rateAnchor && shared.now - m.rateAnchor.ts >= 10000) {
    const dtMin = (shared.now - m.rateAnchor.ts) / 60000;
    m.lagRate = (m.lagBytes - m.rateAnchor.bytes) / 1048576 / dtMin;
    m.rateAnchor = { ts: shared.now, bytes: m.lagBytes };
  }

  Object.assign(base, {
    live: s.live === 'stalled' ? 'stalled' : pending ? 'waiting' : 'running',
    pending,
    turnMs: turnStart ? shared.now - turnStart : null,
    ctx: ctx || snapshotContext(db, s.id, snap ? snap.seq : null),
    speedLast: t.lastSpeed,
    speedLive: liveSpeed,
    spark: m.spark.slice(-SPARK_LEN),
    tokIn: t.lastIn || null,
    tokCached: t.lastCached || null,
    tokOut: t.lastOut || null,
    lagBytes: m.lagBytes,
    lagEvents: m.lagEvents,
    lagRate: m.lagRate,
  });

  m.lastSeq = le ? le.mx : null;
  m.prevTs = shared.now;
  return base;
}

function sumLag(db, id, snapSeq) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(payload)),0) AS b FROM events
        WHERE session_id = ? AND seq > ?`
    )
    .get(id, snapSeq).b;
}

function countLag(db, id, snapSeq) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND seq > ?`)
    .get(id, snapSeq).n;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render(model, blink) {
  const W = model.width;
  const lines = [];

  // --- header box ---------------------------------------------------------
  const inner = W - 4;
  const left = 'ofx live';
  const right = `${clock(model.now)} \u00b7 every ${model.interval}s`;
  const dash = Math.max(1, W - 5 - left.length - right.length);
  lines.push(C.d + '\u250c ' + left + ' ' + '\u2500'.repeat(dash) + ' ' + right + ' \u2510' + C.x);

  const badge = (n, label, color) => color + n + ' ' + label + C.x;
  const waitingN = model.active.filter((s) => s.live === 'waiting').length;
  // A blocked session is an alert: the counter turns red and pulses with the
  // cards. Zero waiting stays dim, so red keeps meaning "someone waits for you".
  const counts = [
    badge(model.active.length, 'active', C.g),
    badge(waitingN, 'waiting', waitingN ? (blink ? C.r + C.b : C.r) : C.d),
    badge(model.stalled.length, 'stalled', C.r),
  ].join('   ');
  const healthParts = [
    `db ${fmtBytes(model.db)}`,
    `wal ${fmtBytes(model.wal)}`,
    model.server.pid ? `pid ${model.server.pid}` : 'no server',
    model.server.rss ? fmtBytes(model.server.rss) : null,
    model.server.cpu != null ? `cpu ${Math.round(model.server.cpu)}%` : null,
  ].filter(Boolean);
  // Keep as much health information as the width allows, never overflow the box.
  let health = '';
  for (let i = 0; i < healthParts.length; i++) {
    const candidate = healthParts.slice(0, i + 1).join(' \u00b7 ');
    if (strip(counts).length + 3 + candidate.length > inner) break;
    health = candidate;
  }
  const boxLine = (content) =>
    C.d + '\u2502 ' + C.x + content + ' '.repeat(Math.max(0, inner - strip(content).length)) + C.d + ' \u2502' + C.x;
  if (health) lines.push(boxLine(rowOf(counts, C.d + health + C.x, inner)));
  else {
    lines.push(boxLine(counts));
    lines.push(boxLine(C.d + healthParts[0] + C.x));
  }
  lines.push(C.d + '\u2514' + '\u2500'.repeat(W - 2) + '\u2518' + C.x);
  lines.push('');

  // --- active cards -------------------------------------------------------
  const cards = [...model.active, ...model.stalled];
  if (!cards.length) {
    lines.push('  ' + C.d + 'no session is running right now' + C.x);
  } else {
    for (const s of cards) lines.push(...renderCard(s, W, blink, model.now));
  }

  // --- history ------------------------------------------------------------
  if (model.history.length && opt.min > 0) {
    const full = `${model.active.length} active \u00b7 filling up to ${opt.min} with the most recently finished sessions`;
    const short = `${model.active.length} active \u00b7 filling to ${opt.min} with finished sessions`;
    const note = full.length <= W - 12 ? full : short;
    lines.push('');
    lines.push('  ' + C.b + 'RECENT' + C.x + C.d + '   ' + trunc(note, Math.max(10, W - 12)) + C.x);
    lines.push(...renderHistory(model.history, W));
    if (W >= 90) {
      lines.push('  ' + C.d + '\u2713 completed \u00b7 \u2717 cancelled \u00b7 ! error \u00b7 ? waiting for a human' + C.x);
    }
    const missing = model.history.filter((s) => s.tokOut == null).length;
    if (missing) {
      const long =
        missing === model.history.length
          ? 'token totals of finished sessions are unavailable (journal purged \u00b7 openfox counters are 0)'
          : `${missing}/${model.history.length} finished sessions without token totals (journal purged)`;
      const brief =
        missing === model.history.length
          ? 'token totals unavailable (journal purged)'
          : `${missing}/${model.history.length} sessions without token totals`;
      lines.push('  ' + C.d + (long.length <= W - 2 ? long : brief) + C.x);
    }
  }

  // --- footer -------------------------------------------------------------
  const foot = [`lag warn ${LAG_MB_WARN} MB \u00b7 crit ${LAG_MB_CRIT} MB`, 'context 70/85%'];
  const anyChecks = model.history.some((s) => s.checks && (s.checks.criteria || s.checks.review_findings));
  if (anyChecks && historyCols(W).some((c) => c[0] === 'checks')) foot.push('checks: criteria \u00b7 findings');
  if (IS_TTY) foot.push('Ctrl+C to quit');
  while (foot.length > 1 && foot.join('   \u00b7   ').length > W - 4) foot.pop();
  lines.push('');
  lines.push('  ' + C.d + foot.join('   \u00b7   ') + C.x);
  return lines.map(trimEnd).join('\n') + '\n';
}

// Remove the padding at the end of a line, including the spaces that sit just
// before a trailing ANSI reset (redirected output must stay clean).
const trimEnd = (s) => s.replace(/[ \t]+(\u001b\[0m)?$/, '$1');

function stateBadge(s, blink) {
  if (s.live === 'running') return { icon: '\u25cf', word: 'RUNNING', color: C.g };
  // The glyph pulses (filled / hollow) so the eye catches it without the word
  // flickering: WAITING stays readable on both phases. Red, never yellow.
  if (s.live === 'waiting')
    return { icon: blink ? '\u25c6' : '\u25c7', word: 'WAITING', color: blink ? C.r + C.b : C.r };
  if (s.live === 'stalled') return { icon: '\u25b2', word: 'STALLED', color: C.r };
  return { icon: '\u25cb', word: 'FINISHED', color: C.d };
}

function renderCard(s, W, blink, now) {
  const b = stateBadge(s, blink);
  const rail = '  ' + b.color + '\u258c' + C.x + ' ';
  const inner = W - 4;
  const out = [];

  const showModel = W >= 96;
  const showSpark = W >= 88;
  const showBar = W >= 78;

  // line 1: badge, id, title, model
  const head =
    b.color + b.icon + ' ' + b.word + C.x +
    '  ' +
    C.d + s.short + C.x +
    '  ' +
    trunc(s.title, Math.max(14, inner - 34 - (showModel ? 20 : 0)));
  out.push(rail + rowOf(head, showModel ? C.d + trunc(s.model, 18) + C.x : '', inner));

  // line 2: step + phase, then elapsed
  // What is blocking the session, so the operator knows where to click: a
  // question in the chat or an access request on a path.
  const pendingWord = s.pending === 'access' ? 'access' : s.pending === 'question' ? 'question' : null;
  // Measured against the render clock, not the sample clock: the badge blinks
  // between two samples, and a frozen "waiting 23s" would be the one number that
  // matters most and never moves.
  const idleMs = s.live === 'waiting' && s.pendingSince != null ? now - s.pendingSince : s.idleMs;
  const whenPlain =
    s.live === 'waiting'
      ? `waiting ${fmtDur(idleMs)}${pendingWord ? ' \u00b7 ' + pendingWord : ''}`
      : s.live === 'stalled'
        ? `no event for ${fmtDur(idleMs)}`
        : `since ${fmtDur(s.turnMs)}`;
  const phasePlain = s.phase && s.phase !== s.step ? ' \u00b7 ' + s.phase : '';
  const stepBudget = Math.max(10, inner - 4 - whenPlain.length - phasePlain.length - 2);
  const stepTxt = s.step ? C.c + trunc(s.step, stepBudget) + C.x : C.d + 'no workflow step' + C.x;
  const phaseTxt = phasePlain ? C.d + phasePlain + C.x : '';
  const when =
    s.live === 'waiting' ? C.r + whenPlain + C.x : s.live === 'stalled' ? C.r + whenPlain + C.x : C.d + whenPlain + C.x;
  out.push(rail + rowOf('    ' + stepTxt + phaseTxt, when, inner));

  if (s.live === 'stalled') {
    out.push(rail + C.d + '    flagged running \u2014 probably a ghost (a restart clears it)' + C.x);
    return out;
  }

  // context
  if (s.ctx && s.ctx.max > 0) {
    const ratio = s.ctx.cur / s.ctx.max;
    const col = s.ctx.danger || ratio >= 0.85 ? C.r : ratio >= 0.7 ? C.y : C.g;
    const pct = Math.round(ratio * 100) + '%';
    const leftTxt = showBar ? `${col}${bar(ratio, 20)}${C.x}  ${fmtK(s.ctx.cur)} / ${fmtK(s.ctx.max)}` : `${fmtK(s.ctx.cur)} / ${fmtK(s.ctx.max)}`;
    out.push(rail + rowOf('    ' + C.d + pad('context', 10) + C.x + leftTxt, col + pct + C.x, inner));
  } else {
    out.push(rail + '    ' + C.d + pad('context', 10) + '\u2014' + C.x);
  }

  // acceptance criteria / review findings (one summary line each, or the full
  // list with --items)
  if (s.checks) {
    for (const [key, label] of [
      ['criteria', 'criteria'],
      ['review_findings', 'review'],
    ]) {
      const list = s.checks[key];
      if (!list) continue;
      out.push(...renderChecks(rail, label, list, inner));
    }
  }

  // speed
  const speedLast = s.speedLast != null ? s.speedLast.toFixed(1) + ' tok/s' : null;
  // A zero here means "no token emitted during this window" (tool call, pause):
  // showing "live 0.0" would read as a stall, so only a positive rate is printed.
  const speedLive = s.speedLive != null && s.speedLive > 0 ? `live \u2248 ${s.speedLive.toFixed(1)}` : null;
  const speedTxt = [speedLast, speedLive ? C.d + speedLive + C.x : null].filter(Boolean).join('  ');
  const spark = showSpark && s.spark && s.spark.length > 1 ? C.c + sparkline(s.spark) + C.x : '';
  out.push(
    rail +
      rowOf(
        '    ' + C.d + pad('speed', 10) + C.x + (speedTxt || C.d + '\u2014' + C.x),
        spark,
        inner
      )
  );

  // tokens
  if (s.tokOut != null) {
    const cachedPct = s.tokIn > 0 ? Math.round((s.tokCached / s.tokIn) * 100) : 0;
    const txt =
      `prompt ${fmtK(s.tokIn)} (${cachedPct}% cached) \u00b7 out ${fmtK(s.tokOut)}`;
    out.push(rail + '    ' + C.d + pad('tokens', 10) + C.x + txt);
  } else {
    // The chat.done that follows a question carries no usage: on a waiting card
    // "awaiting first chat.done" would read as a contradiction, so show nothing
    // rather than something false.
    const txt = s.live === 'waiting' ? '\u2014' : 'awaiting first chat.done';
    out.push(rail + '    ' + C.d + pad('tokens', 10) + txt + C.x);
  }

  // lag
  const lagMb = s.lagBytes / 1048576;
  const lagCol = lagMb > LAG_MB_CRIT ? C.r : lagMb > LAG_MB_WARN ? C.y : C.g;
  const evs = C.d + `  \u00b7 ${Number(s.lagEvents || 0).toLocaleString('en-US')} ev` + C.x;
  const rate = s.lagRate != null ? C.d + `  (+${s.lagRate.toFixed(2)} MB/min)` + C.x : '';
  const status = lagMb > LAG_MB_CRIT ? 'critical' : lagMb > LAG_MB_WARN ? 'warn' : 'ok';
  out.push(
    rail +
      rowOf(
        '    ' + C.d + pad('lag', 10) + C.x + lagCol + fmtBytes(s.lagBytes) + C.x + evs + rate,
        lagCol + status + C.x,
        inner
      )
  );

  return out;
}

// One line per list: a glyph per item (that is the "validated one by one" view),
// the done/total ratio, then the non-terminal statuses. With --items the list is
// expanded below, one line per item.
function renderChecks(rail, label, list, inner) {
  const out = [];
  const ratioTxt = `${list.done}/${list.total} done`;
  let budget = inner - 4 - 10 - 2 - ratioTxt.length;

  let breakdown = checkBreakdown(list);
  // Keep the breakdown only if enough room is left for a readable strip.
  if (breakdown && budget - 3 - strip(breakdown).length >= Math.min(list.total, 6)) {
    budget -= 3 + strip(breakdown).length;
  } else {
    breakdown = '';
  }

  let glyphs = '';
  if (budget >= 2) {
    const shown = Math.min(list.total, budget);
    const parts = list.items.slice(0, shown).map(glyphOf);
    if (shown < list.total) parts[parts.length - 1] = C.d + '+' + C.x;
    glyphs = parts.join('');
  }

  out.push(
    rail +
      '    ' +
      C.d +
      pad(label, 10) +
      C.x +
      glyphs +
      (glyphs ? '  ' : '') +
      ratioTxt +
      (breakdown ? '   ' + breakdown : '')
  );

  if (opt.items) {
    const budgetDesc = Math.max(16, inner - 12);
    for (const item of list.items.slice(0, MAX_ITEMS)) {
      out.push(
        rail +
          '      ' +
          glyphOf(item) +
          ' ' +
          pad(item.id, 2) +
          '  ' +
          trunc(item.description || '(no description)', budgetDesc)
      );
    }
    if (list.items.length > MAX_ITEMS) {
      out.push(rail + C.d + '      \u2026 +' + (list.items.length - MAX_ITEMS) + ' more' + C.x);
    }
  }
  return out;
}

function glyphOf(item) {
  const info = CHECK_STATUS[item.status] || { glyph: '?', color: 'd' };
  return C[info.color] + info.glyph + C.x;
}

function checkBreakdown(list) {
  const statuses = Object.keys(list.counts).filter((st) => list.counts[st] > 0);
  // "8/8 done" already says everything when the only status is the happy one.
  if (statuses.length === 1 && (statuses[0] === 'passed' || statuses[0] === 'resolved')) return '';
  const order = ['failed', 'open', 'completed', 'passed', 'resolved', 'pending', 'dismissed'];
  // Unknown statuses come last, under their raw name: never silently dropped.
  for (const st of Object.keys(list.counts)) if (!order.includes(st)) order.push(st);
  const parts = [];
  for (const st of order) {
    const n = list.counts[st];
    if (!n) continue;
    const info = CHECK_STATUS[st] || { word: st, color: 'd' };
    parts.push(C[info.color] + `${n} ${info.word}` + C.x);
  }
  return parts.join(C.d + ' \u00b7 ' + C.x);
}

function checksCell(checks) {
  if (!checks) return '\u2014';
  const parts = [];
  if (checks.criteria) parts.push(`${checks.criteria.done}/${checks.criteria.total}`);
  if (checks.review_findings) parts.push(`${checks.review_findings.done}/${checks.review_findings.total}`);
  return parts.length ? parts.join(' \u00b7 ') : '\u2014';
}

// Column set of the RECENT table, shared with the footer legend so both agree on
// whether the CHECKS column is displayed.
function historyCols(W) {
  const avail = W - 2;
  // Columns by priority: the optional ones are dropped when the terminal is
  // narrow, and STEP gets whatever space is left.
  const fixed = { session: 8, duration: 9 };
  const optional = [
    ['ctx', 'FINAL CONTEXT', 22, 'l'],
    ['checks', 'CHECKS', 13, 'l'],
    ['ended', 'ENDED', 9, 'r'],
    ['out', 'OUT', 6, 'r'],
    ['speed', 'tok/s', 6, 'r'],
    ['model', 'MODEL', 16, 'l'],
  ];
  const chosen = [];
  let used = fixed.session + fixed.duration;
  for (const [key, name, w, align] of optional) {
    // Keep at least 20 columns for STEP: it is the column that says what the
    // session did, and squeezing it below that makes the row unreadable.
    if (used + w + 2 * (chosen.length + 3) + 20 > avail) continue;
    chosen.push([key, name, w, align]);
    used += w;
  }
  const cols = [
    ['session', 'SESSION', fixed.session, 'l'],
    ['step', 'STEP', Math.max(14, avail - used - 2 * (chosen.length + 2)), 'l'],
    ['duration', 'DURATION', fixed.duration, 'l'],
    // Selected by priority above, displayed in a stable reading order.
    ...['ctx', 'out', 'speed', 'checks', 'model', 'ended']
      .map((key) => chosen.find((c) => c[0] === key))
      .filter(Boolean),
  ];
  return cols;
}

function renderHistory(rows, W) {
  const cols = historyCols(W);
  const w = cols.map((c) => c[2]);

  const out = [];
  const header = cols.map(([key, name, width, align]) => (align === 'r' ? padL(name, width) : pad(name, width))).join('  ');
  out.push('  ' + C.d + pad(header, W - 2) + C.x);
  out.push('  ' + C.d + '\u2500'.repeat(W - 2) + C.x);

  for (const s of rows) {
    const modelIdx = cols.findIndex((c) => c[0] === 'model');
    const mark =
      s.outcome === 'completed'
        ? ' \u2713'
        : s.outcome === 'cancelled'
          ? ' \u2717'
          : s.outcome === 'error'
            ? ' !'
            : s.outcome === 'waiting_for_user'
              ? ' ?'
              : '';
    const values = {
      session: s.short,
      step: trunc(s.step || '\u2014', w[1] - mark.length) + mark,
      duration: fmtDur(s.duration),
      ctx:
        s.ctx && s.ctx.max > 0
          ? `${bar(s.ctx.cur / s.ctx.max, 10)} ${fmtK(s.ctx.cur)}/${fmtK(s.ctx.max)}`
          : '\u2014',
      ended: fmtAge(s.endedMs),
      out: s.tokOut != null ? fmtK(s.tokOut) : '\u2014',
      checks: checksCell(s.checks),
      speed: s.speed != null ? s.speed.toFixed(1) : '\u2014',
      model: modelIdx >= 0 ? trunc(s.model, w[modelIdx]) : '',
    };
    const line = cols
      .map(([key, , width, align]) => (align === 'r' ? padL(strip(values[key]), width) : pad(strip(values[key]), width)))
      .join('  ');
    out.push('  ' + C.d + line + C.x);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A blocked session blinks without costing a sample: the frame is redrawn from
// the model already in memory every BLINK_MS while somebody waits, and the
// database is still opened once per --interval (no extra query, no WAL snapshot).
const BLINK_MS = 500;
// The pulse is bounded: past this age the card stays red and first in the list
// but stops animating, so an abandoned question (or a session whose process died
// while a question was pending) cannot keep a 2 Hz full-screen redraw running.
const BLINK_MAX_MS = 60 * 1000;

async function main() {
  const state = { tick: 0 };
  let n = 0;
  let model = null;
  let dueAt = 0;
  let phase = true;
  hideCursor();
  for (;;) {
    let fresh = false;
    if (!model || Date.now() >= dueAt) {
      try {
        model = sample(state);
      } catch (e) {
        showCursor();
        console.error('  \u2717 sampling failed: ' + (e && e.message ? e.message : e));
        process.exit(2);
      }
      dueAt = Date.now() + opt.interval * 1000;
      fresh = true;
    }
    // Only a color terminal animates: a redirected frame must stay byte-stable,
    // so it is always drawn on the "on" phase (WAITING + question/access). The
    // TTY test is explicit, not implied by useColor.
    const drawnAt = Date.now();
    const pulsing =
      IS_TTY &&
      useColor &&
      model.active.some(
        (s) => s.live === 'waiting' && s.pendingSince != null && drawnAt - s.pendingSince < BLINK_MAX_MS
      );
    if (fresh) {
      if (IS_TTY) {
        process.stdout.write('\u001b[2J\u001b[H' + render(model, pulsing ? phase : true));
      } else {
        if (n > 0) process.stdout.write('\n');
        process.stdout.write(`# ${new Date(model.now).toISOString()}  every ${opt.interval}s\n`);
        process.stdout.write(render(model, true));
      }
      n++;
      if (opt.samples && n >= opt.samples) break;
    } else {
      // Blink tick: same model, fresh clock, no database access at all.
      process.stdout.write('\u001b[2J\u001b[H' + render({ ...model, now: Date.now() }, phase));
    }
    if (!pulsing) {
      await sleep(Math.max(50, dueAt - Date.now()));
      continue;
    }
    phase = !phase;
    await sleep(Math.min(BLINK_MS, Math.max(50, dueAt - Date.now())));
  }
  showCursor();
}

main().catch((e) => {
  showCursor();
  console.error('  \u2717 unexpected error: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
