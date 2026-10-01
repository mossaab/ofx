#!/usr/bin/env node
// ofx.cjs — OpenFox command console: list, inspect, plan, act.
//
// Service lifecycle AND data diagnostics in a single tool.
//
//   ofx service <action>   service lifecycle (absorbed from openfox-ctl)
//   ofx <other>            data and diagnostics (sessions.db, thresholds, decisions)
//
// This tool absorbed the script ~/.local/bin/openfox-ctl. That script was NOT shipped
// with OpenFox (no file in /opt/openfox references it: it was written by hand), so
// nothing regenerates it and absorbing it breaks no update.
//
// The two destructive commands (service install, service upgrade) carry a safety
// guard: interactive confirmation is MANDATORY, with no bypass option.
//
// Unifies the tools already present in this folder and adds the DECISION layer:
//   openfox-watchdog.sh        -> overall health, thresholds, exit code
//   openfox-watchdog-db.cjs    -> database metrics
//   openfox-session-watch.cjs  -> live growth
//   openfox-backup.cjs         -> coherent backup (online backup API)
//   openfox-vacuum.cjs         -> offline VACUUM
//
// SAFETY PRINCIPLE (3 tiers):
//   1. READ ONLY      : list, inspect, plan, status, watch, diagnose, backup
//                       -> database opened readonly + query_only, no writes at all
//   2. WRITES VIA API : stop/pause/resume/continue -> POST /api/sessions/:id/*
//                       -> goes through the server, so its caches stay coherent
//   3. OFFLINE WRITES : compact --apply -> backup mandatory BEFORE any action
//
// WHAT THIS CLI DELIBERATELY DOES NOT DO:
//   - it does NOT re-implement compaction. Consolidation (fold + deletion +
//     new snapshot) is server-internal code (EventStore.consolidateSession).
//     Replaying it here would risk corrupting the session. We only VERIFY
//     eligibility and orchestrate the restart, which triggers the official
//     consolidation at startup.
//   - it does NOT expose POST /api/sessions/:id/truncate: that route cuts the
//     conversation destructively (deleteEventsAfterSeq). It is not a compaction.
//     Do it from the UI, with full knowledge.
//   - it NEVER writes to sessions.db while the server is running.
//
// USAGE
//   ofx                       help
//   ofx status                service + API + database + process state
//   ofx list [--all]          sessions: volume, snapshots, lag
//   ofx inspect <id|--hot>    session detail [--fast]
//   ofx plan <id|--hot>       consolidation impact (dry-run, never writes)
//   ofx watch [--interval N]  live growth (delegated)
//   ofx diagnose              health report (delegated, watchdog thresholds)
//   ofx backup [--out DIR]    coherent backup (delegated)
//   ofx stop|pause|resume|continue <id>     action via the API
//   ofx compact <id|--hot> [--apply] [--restart] [--yes]
//   ofx service <start|stop|restart|status|install|upgrade>   service lifecycle
//   ofx logs [N] [-f]         service journal
//   ofx auth <login|set-token|status|check|clear>            credentials (masked input)
//   ofx export <id|--hot> [-o file]        export a session (modifies nothing)
//   ofx import <file> --project <id>       re-import an export (CREATES a session)
//   ofx new --project <id> [--title "..."]    create a session
//   ofx rm <id|--hot> [--yes]                 delete a session (PERMANENT)
//
// AUTHENTICATION (tier 2; the API returns "Unauthorized" without a token):
//   ofx auth login              asks for the password (masked) and stores a token
//   OPENFOX_TOKEN=<token>       direct token (takes priority)
//   OPENFOX_PASSWORD=<password>  exchanged for a token via /api/auth/login
//   Priority: OPENFOX_TOKEN > token file > OPENFOX_PASSWORD.
//   Read commands need no credentials at all.
//
// EXIT CODES
//   0 = success
//   1 = usage error / unmet precondition
//   2 = requested operation failed
//
// Environment variables: OPENFOX_DB_PATH, OPENFOX_WD_SQLITE, OPENFOX_HOST,
// OPENFOX_PORT, OPENFOX_SERVICE (default: openfox)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SQLITE_MODULE =
  process.env.OPENFOX_WD_SQLITE || '/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3';
const DB_PATH =
  process.env.OPENFOX_DB_PATH || path.join(process.env.HOME || '.', '.local/share/openfox/sessions.db');
const API_BASE = `http://${process.env.OPENFOX_HOST || '127.0.0.1'}:${Number(process.env.OPENFOX_PORT || 10369)}`;
const SERVICE = process.env.OPENFOX_SERVICE || 'openfox';
const SCRIPT_DIR = __dirname;

// ofx credentials, stored outside environment variables (see ofx auth).
// Dedicated folder for ofx: we do not write into ~/.config/openfox, which belongs to OpenFox.
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '.', '.config');
const OFX_CONFIG_DIR = path.join(XDG_CONFIG, 'ofx');
const OFX_TOKEN_FILE = process.env.OPENFOX_TOKEN_FILE || path.join(OFX_CONFIG_DIR, 'token');

// Thresholds aligned with openfox-watchdog.sh (single source of truth for alerts).
const LAG_MB_WARN = Number(process.env.OPENFOX_WD_LAG_MB_WARN || 20);
const LAG_MB_CRIT = Number(process.env.OPENFOX_WD_LAG_MB_CRIT || 100);

// Below this lag, a session has nothing interesting for the default view.
const NOTABLE_LAG_BYTES = 1024 * 1024;

// Constraints of OpenFox's export/import format, taken from the server code:
//   SESSION_EXPORT_FORMAT = "openfox-session", SESSION_EXPORT_VERSION = 1
//     (dist/export-import-D76452VS.js)
//   app.use(express.json({ limit: "75mb" }))
//     (dist/chunk-2J6OW67H.js:8608)
// The server's zod schema rejects any payload that does not match exactly.
const EXPORT_FORMAT = 'openfox-session';
const EXPORT_VERSION = 1;
const API_BODY_LIMIT_MB = Number(process.env.OPENFOX_API_BODY_LIMIT_MB || 75);
const IMPORT_MARGIN_BYTES = 1024 * 1024;

// Must stay identical to EventStore.findOrphanedSessions(): a session is
// consolidable only if it is stopped AND updated_at is older than 5 minutes.
const STALE_RUNNING_MS = 5 * 60 * 1000;

// Must stay identical to EventStore.cleanupOldEvents(): these types survive the
// routine purge because they carry state (not a stream).
const CLEANUP_KEEP_TYPES = [
  'criteria.set',
  'criterion.updated',
  'mode.changed',
  'phase.changed',
  'todo.updated',
  'context.state',
  'metadata.set',
];

// ---------------------------------------------------------------------------
// Display utilities
// ---------------------------------------------------------------------------
const C = process.stdout.isTTY
  ? { r: '\u001b[31m', g: '\u001b[32m', y: '\u001b[33m', b: '\u001b[1m', d: '\u001b[2m', x: '\u001b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', x: '' };

const ok = (s) => console.log('  ' + C.g + '\u2713' + C.x + ' ' + s);
const ko = (s) => console.log('  ' + C.r + '\u2717' + C.x + ' ' + s);
const warn = (s) => console.log('  ' + C.y + '!' + C.x + ' ' + s);
const info = (s) => console.log('    ' + s);
const rule = () => console.log('  ' + C.d + '\u2500'.repeat(72) + C.x);
const head = (s) => {
  console.log('');
  console.log('  ' + C.b + s + C.x);
};
const dim = (s) => C.d + s + C.x;

function fail(msg, code = 1) {
  console.log('');
  ko(msg);
  process.exit(code);
}

const pad = (s, n) => {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
};
const padL = (s, n) => {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
};
const fmtBytes = (n) => {
  n = Number(n || 0);
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};
const fmtAge = (ms) => {
  if (ms == null || Number.isNaN(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
};
const shortId = (id) => String(id).slice(0, 8);

// Positional arguments, skipping options and the VALUE of those that take one.
// Without this, '-o file.json' would make 'file.json' look like a session selector.
function positionalOf(argv, valueFlags = []) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

// Value of a named option: optValue(argv, ['-o','--out'])
function optValue(argv, names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

// A selector is either an identifier (full or prefix) or --hot on its own.
function selectorOf(argv, valueFlags = []) {
  const pos = positionalOf(argv, valueFlags);
  if (pos.length) return pos[0];
  if (argv.includes('--hot')) return '--hot';
  return null;
}

// ---------------------------------------------------------------------------
// Database access (READ ONLY — never any offline write here)
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

// ---------------------------------------------------------------------------
// Processes holding the database (/proc/*/fd scan, no lsof dependency)
// ---------------------------------------------------------------------------
function findHolders(dbPath) {
  let real;
  try {
    real = fs.realpathSync(dbPath);
  } catch {
    return [];
  }
  const targets = new Set();
  for (const p of [real, real + '-wal', real + '-shm']) {
    let r = p;
    try {
      r = fs.realpathSync(p);
    } catch {
      /* the -wal file may not exist */
    }
    targets.add(r);
  }
  const out = [];
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    let hit = false;
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.startsWith('/')) continue;
      let r = target;
      try {
        r = fs.realpathSync(target);
      } catch {
        /* file deleted while reading */
      }
      if (targets.has(target) || targets.has(r)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch {
      /* process gone */
    }
    let rss = 0;
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)/.exec(st);
      if (m) rss = Number(m[1]) * 1024;
    } catch {
      /* ignore */
    }
    out.push({ pid: Number(pid), cmd, rss });
  }
  // A single OpenFox process can open the database several times (main + workers):
  // keep only one representative per command line.
  const seen = new Set();
  return out.filter((h) => {
    const key = h.cmd || String(h.pid);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function openfoxProcesses() {
  const out = [];
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    const line = cmd.join(' ');
    if (!/bin\/openfox/.test(line)) continue;
    let rss = 0;
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)/.exec(st);
      if (m) rss = Number(m[1]) * 1024;
    } catch {
      /* ignore */
    }
    let heap = null;
    const hm = /--max-old-space-size=(\d+)/.exec(line);
    if (hm) heap = Number(hm[1]);
    out.push({ pid: Number(pid), cmd: line, rss, heapMb: heap });
  }
  return out.sort((a, b) => b.rss - a.rss);
}

// ---------------------------------------------------------------------------
// Database metrics (set-based queries: no N+1 over 200+ sessions)
// ---------------------------------------------------------------------------
function aggregateBySession(db) {
  const perSession = new Map();
  for (const r of db
    .prepare(
      `SELECT session_id AS id, COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes,
              COALESCE(MAX(seq),0) AS max_seq, COALESCE(MAX(timestamp),0) AS last_ts,
              SUM(CASE WHEN event_type='turn.snapshot' THEN 1 ELSE 0 END) AS snaps
         FROM events GROUP BY session_id`
    )
    .all()) {
    perSession.set(r.id, { ...r, snap_seq: 0, lag_events: 0, lag_bytes: 0 });
  }
  for (const r of db
    .prepare(
      `SELECT session_id AS id, COALESCE(MAX(seq),0) AS mx FROM events
        WHERE event_type='turn.snapshot' GROUP BY session_id`
    )
    .all()) {
    const e = perSession.get(r.id);
    if (e) e.snap_seq = r.mx;
  }
  for (const r of db
    .prepare(
      `SELECT e.session_id AS id, COUNT(*) AS n, COALESCE(SUM(LENGTH(e.payload)),0) AS b
         FROM events e
         LEFT JOIN (SELECT session_id, MAX(seq) AS mx FROM events
                     WHERE event_type='turn.snapshot' GROUP BY session_id) s
                ON s.session_id = e.session_id
        WHERE e.seq > COALESCE(s.mx, 0)
        GROUP BY e.session_id`
    )
    .all()) {
    const e = perSession.get(r.id);
    if (e) {
      e.lag_events = r.n;
      e.lag_bytes = r.b;
    }
  }
  return perSession;
}

function sessionsOf(db) {
  return db
    .prepare(
      `SELECT id, title, is_running, updated_at, phase, mode, message_count, workdir
         FROM sessions`
    )
    .all();
}

function sessionMetrics(db) {
  const per = aggregateBySession(db);
  return sessionsOf(db).map((s) => {
    per.get(s.id);
    return {
      ...s,
      ...(per.get(s.id) || { n: 0, bytes: 0, max_seq: 0, last_ts: 0, snaps: 0, snap_seq: 0, lag_events: 0, lag_bytes: 0 }),
    };
  });
}

// Resolves a session selector: full identifier, prefix, or --hot.
function resolveSession(rows, selector) {
  if (selector === '--hot' || selector === 'hot') {
    const hot = [...rows].sort((a, b) => b.lag_bytes - a.lag_bytes)[0];
    if (!hot) fail('no session in the database', 1);
    return hot;
  }
  const exact = rows.find((s) => s.id === selector);
  if (exact) return exact;
  const matches = rows.filter((s) => s.id.startsWith(selector));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log('');
    ko(`"${selector}" is ambiguous, ${matches.length} sessions match:`);
    for (const m of matches.slice(0, 10)) info(`${shortId(m.id)}  ${String(m.title || '').slice(0, 50)}`);
    console.log('');
    process.exit(1);
  }
  fail(`session not found: ${selector}`, 1);
}

// Consolidation eligibility evaluator, a copy of findOrphanedSessions().
// Two kinds of blocker are distinguished:
//   auto     = cleared by a plain restart (initEventStore forces is_running = 0)
//   blocking = requires human action or waiting; a restart changes nothing
function consolidationEligibility(row) {
  const auto = [];
  const blocking = [];
  const ageMs = Date.parse(row.updated_at) ? Date.now() - Date.parse(row.updated_at) : null;

  if (!row.n) blocking.push('the session contains no events');
  if (row.is_running) {
    auto.push('is_running = 1 — initEventStore() forces is_running = 0 on ALL sessions at startup');
  }
  if (ageMs == null) blocking.push('unreadable updated_at');
  else if (ageMs < STALE_RUNNING_MS) {
    const wait = Math.ceil((STALE_RUNNING_MS - ageMs) / 1000);
    blocking.push(`updated_at is less than 5 minutes old — wait ${wait} s (a restart does not make updated_at younger)`);
  }
  if (!row.snaps) {
    blocking.push("no turn.snapshot — findOrphanedSessions() requires an existing snapshot, and a restart creates none");
  }
  if (row.n && !row.lag_events) {
    blocking.push('no events after the last snapshot — nothing to consolidate');
  }

  return {
    eligible: auto.length === 0 && blocking.length === 0,
    eligibleAfterRestart: blocking.length === 0 && auto.length > 0,
    auto,
    blocking,
    reasons: [...blocking, ...auto],
    ageMs,
  };
}

// ---------------------------------------------------------------------------
// Service lifecycle (absorbed from openfox-ctl)
// ---------------------------------------------------------------------------
// The systemd unit is named SERVICE ('openfox').
//
// WHY 'stop + sleep 1 + start' instead of 'systemctl restart': the history of the
// original script documents EADDRINUSE on port 10369 when the old process had not
// released the port yet. The one-second delay is deliberate.
const OPENFOX_DIR = process.env.OPENFOX_DIR || '/opt/openfox';
const RUNTIME_DIR = path.join(process.env.HOME || '', '.openfox');
const LOG_FILE = path.join(RUNTIME_DIR, 'openfox.log');
const PORT = Number(process.env.OPENFOX_PORT || 10369);
const REPO = process.env.OPENFOX_REPO || 'co-l/openfox';

function svcDo(action) {
  return spawnSync('sudo', ['systemctl', action, SERVICE], { stdio: 'inherit' });
}
function svcIsActive() {
  return spawnSync('systemctl', ['is-active', '--quiet', SERVICE]).status === 0;
}
function svcMainPid() {
  const r = spawnSync('systemctl', ['show', '-p', 'MainPID', '--value', SERVICE], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && p !== '0' ? p : null;
}
function svcRestart() {
  svcDo('stop');
  spawnSync('sleep', ['1']);
  return svcDo('start');
}

// Installed version, read from package.json; falls back to 'openfox --version'.
function installedVersion() {
  for (const p of [
    path.join(OPENFOX_DIR, 'lib/node_modules/openfox/package.json'),
    path.join(OPENFOX_DIR, 'lib/node_modules/openfox/dist/package.json'),
  ]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) return v;
    } catch {
      /* try the next one */
    }
  }
  const r = spawnSync(path.join(OPENFOX_DIR, 'bin/openfox'), ['--version'], { encoding: 'utf8' });
  const v = (r.stdout || '').trim().split('\n')[0];
  return v || 'unknown';
}

// Latest published version, via the GitHub API (same source as the original script).
async function latestVersion() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ofx' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const tag = String(j.tag_name || '').replace(/^v/, '');
  if (!tag) throw new Error('tag_name missing from the response');
  return tag;
}

function userGroup() {
  const u = (spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout || '').trim() || process.env.USER || '';
  const g = (spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout || '').trim();
  return g ? `${u}:${g}` : u;
}

// ---------------------------------------------------------------------------
// Delegation to the existing scripts (single source of truth)
// ---------------------------------------------------------------------------
function runSibling(name, args) {
  const p = path.join(SCRIPT_DIR, name);
  if (!fs.existsSync(p)) fail(`sibling script not found: ${p}`, 1);
  console.log(dim(`  \u2192 ${name} ${args.join(' ')}`));
  console.log('');
  // .sh files are launched with bash; .cjs files with the current interpreter (the
  // one whose ABI matches better-sqlite3).
  const isShell = name.endsWith('.sh');
  const r = isShell
    ? spawnSync('/bin/bash', [p, ...args], { stdio: 'inherit' })
    : spawnSync(process.execPath, [p, ...args], { stdio: 'inherit' });
  if (r.error) fail(`cannot execute: ${r.error.message}`, 2);
  process.exit(r.status == null ? 2 : r.status);
}

// ---------------------------------------------------------------------------
// Tier 2: HTTP API (the server keeps its caches coherent)
// ---------------------------------------------------------------------------
async function apiFetch(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.token) headers['x-session-token'] = opts.token;
  if (opts.body) headers['content-type'] = 'application/json';
  return fetch(API_BASE + pathname, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
}

// ---------------------------------------------------------------------------
// Masked input (password, token)
// ---------------------------------------------------------------------------
// Character-by-character input in raw mode: nothing is sent back to the terminal
// server, so nothing can be echoed on another TTY, left in a history, or appear
// in `ps`. The only characters displayed are the '*'.
function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY) {
      reject(new Error("masked input impossible: stdin is not a terminal"));
      return;
    }
    output.write(prompt);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.resume();

    let buf = '';
    const finish = (fn) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(buf));
        if (ch === '\u0003') {
          return finish(() => {
            output.write('cancelled\n');
            process.exit(130);
          });
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (ch === '\u0015') {
          // Ctrl+U: clear the current line
          output.write('\b \b'.repeat(buf.length));
          buf = '';
          continue;
        }
        buf += ch;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}

// Fingerprint of a secret: enough to identify it without revealing it.
function fingerprint(secret) {
  const s = String(secret);
  return s.slice(0, 8) + '\u2026' + `  (${s.length} characters)`;
}

// ---------------------------------------------------------------------------
// Token stored on disk
// ---------------------------------------------------------------------------
function readTokenFile() {
  let st;
  try {
    st = fs.statSync(OFX_TOKEN_FILE);
  } catch {
    return null;
  }
  let value = '';
  try {
    value = fs.readFileSync(OFX_TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
  const mode = st.mode & 0o777;
  return {
    value: value || null,
    path: OFX_TOKEN_FILE,
    mode,
    perms: mode.toString(8).padStart(3, '0'),
    mtime: st.mtimeMs,
  };
}

// Atomic write, and above all NEVER a world-readable file:
// we create a temporary file with 600 (flag 'wx', so exclusive creation with these
// permissions) and then rename it. A direct writeFileSync on an existing file would
// keep its old permissions for the duration of the write.
function writeTokenFile(token) {
  fs.mkdirSync(OFX_CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(OFX_CONFIG_DIR, 0o700);
  } catch {
    /* best effort */
  }
  const tmp = OFX_TOKEN_FILE + '.tmp';
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* no leftover */
  }
  fs.writeFileSync(tmp, String(token).trim() + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, OFX_TOKEN_FILE);
}

// Which credential source would ofx use? Same priority order as apiToken().
// Used to not display a false state when only the token file is present.
function credentialSource() {
  if (process.env.OPENFOX_TOKEN) {
    return { kind: 'env-token', label: 'OPENFOX_TOKEN', fingerprint: fingerprint(process.env.OPENFOX_TOKEN) };
  }
  const f = readTokenFile();
  if (f && f.value) {
    return { kind: 'file', label: OFX_TOKEN_FILE, fingerprint: fingerprint(f.value), file: f };
  }
  if (process.env.OPENFOX_PASSWORD) {
    return { kind: 'env-password', label: 'OPENFOX_PASSWORD' };
  }
  return null;
}

async function apiToken() {
  // 1. environment variable: explicit priority
  if (process.env.OPENFOX_TOKEN) return process.env.OPENFOX_TOKEN;

  // 2. token file (see ofx auth login)
  const f = readTokenFile();
  if (f && f.value) return f.value;

  // 3. password: exchanged for a token on every call
  const pwd = process.env.OPENFOX_PASSWORD;
  if (!pwd) return null;
  try {
    const r = await apiFetch('/api/auth/login', { method: 'POST', body: { password: pwd }, timeoutMs: 8000 });
    if (!r.ok) return null;
    const j = await r.json();
    return j.token || null;
  } catch {
    return null;
  }
}

async function apiHealth() {
  try {
    const r = await apiFetch('/api/health', { timeoutMs: 4000 });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function requireTokenOrExplain(token) {
  if (token) return token;
  console.log('');
  ko('the API requires authentication and no token is available');
  console.log('');
  info(`the simplest way: ${C.b}ofx auth login${C.x}`);
  info(dim('  asks for the password without echo and stores a token with 600 permissions'));
  console.log('');
  info('or, without storing anything, via environment variables:');
  info(dim(`  OPENFOX_TOKEN='<token>'    ofx ${process.argv.slice(2).join(' ')}`));
  info(dim(`  OPENFOX_PASSWORD='<password>'   ofx ${process.argv.slice(2).join(' ')}`));
  console.log('');
  info(dim('credential status: ofx auth status'));
  info(dim('API-free alternative: tier 1 (list, inspect, plan) works without a token.'));
  console.log('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Command: list
// ---------------------------------------------------------------------------
function cmdList(argv) {
  const all = argv.includes('--all');
  const db = openDb();
  const rows = sessionMetrics(db);
  db.close();

  const visible = rows
    .filter((s) => all || s.is_running || s.lag_bytes > NOTABLE_LAG_BYTES)
    .sort((a, b) => {
      if (a.is_running !== b.is_running) return b.is_running - a.is_running;
      return b.lag_bytes - a.lag_bytes;
    });

  const LIMIT = all ? visible.length : 25;
  const shown = visible.slice(0, LIMIT);

  console.log('');
  console.log(`  ${C.b}ofx list${C.x}   ${rows.length} sessions in the database`);
  console.log('');
  console.log(
    '  ' +
      dim(pad('SESSION', 10) + pad('STATE', 9) + padL('EVENTS', 9) + '  ' + padL('DATA', 10) + '  ' + padL('SNAP', 5) + '  ' + padL('LAG EVTS', 11) + '  ' + padL('LAG', 11) + '  ' + 'LAST')
  );
  rule();

  for (const s of shown) {
    const lagMb = s.lag_bytes / 1048576;
    let lagCol = padL(lagMb.toFixed(1) + ' MB', 11);
    if (lagMb > LAG_MB_CRIT) lagCol = C.r + lagCol + C.x;
    else if (lagMb > LAG_MB_WARN) lagCol = C.y + lagCol + C.x;

    const snapCol = s.snaps === 0 ? C.r + padL('0', 5) + C.x : padL(s.snaps, 5);
    const stateCol = s.is_running ? C.y + pad('RUN', 9) + C.x : pad('', 9);

    console.log(
      '  ' +
        pad(shortId(s.id), 10) +
        stateCol +
        padL(s.n.toLocaleString('en-US'), 9) +
        '  ' +
        padL(fmtBytes(s.bytes), 10) +
        '  ' +
        snapCol +
        '  ' +
        padL(s.lag_events.toLocaleString('en-US'), 11) +
        '  ' +
        lagCol +
        '  ' +
        fmtAge(Date.now() - s.last_ts)
    );
    if (s.title) console.log('  ' + C.d + '  ' + String(s.title).slice(0, 64) + C.x);
  }

  if (visible.length > shown.length) {
    console.log('');
    info(dim(`… and ${visible.length - shown.length} more beyond the limit — --all to see everything`));
  }
  if (!all) {
    const hidden = rows.length - visible.length;
    if (hidden > 0) info(dim(`${hidden} session(s) without notable lag hidden`));
  }

  const total = rows.reduce((a, s) => a + s.lag_bytes, 0);
  const worst = [...rows].sort((a, b) => b.lag_bytes - a.lag_bytes)[0];
  console.log('');
  rule();
  if (worst && worst.lag_bytes > 0) {
    info(`cumulative lag: ${fmtBytes(total)}   |   worst session: ${shortId(worst.id)} (${fmtBytes(worst.lag_bytes)})`);
    info(dim(`thresholds: warn ${LAG_MB_WARN} MB, critical ${LAG_MB_CRIT} MB — every state load re-reads the whole lag`));
  } else {
    ok('no snapshot lag: nothing to compact');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Command: inspect
// ---------------------------------------------------------------------------
function cmdInspect(argv) {
  const selector = selectorOf(argv);
  const fast = argv.includes('--fast');
  if (!selector) fail('usage: ofx inspect <id|--hot> [--fast]', 1);

  const db = openDb();
  const rows = sessionMetrics(db);
  const s = resolveSession(rows, selector);

  head(`SESSION ${s.id}`);
  info(`title        : ${s.title || dim('(untitled)')}`);
  info(`state         : ${s.is_running ? C.y + 'RUNNING' + C.x : 'stopped'}`);
  info(`workdir      : ${s.workdir || '-'}`);
  info(`phase / mode : ${s.phase} / ${s.mode}`);
  info(`messages     : ${s.message_count}`);
  info(`created      : ${s.created_at || '-'}   updated : ${s.updated_at || '-'}`);

  head('VOLUME');
  info(`events       : ${s.n.toLocaleString('en-US')}`);
  info(`size         : ${fmtBytes(s.bytes)}`);
  info(`snapshots    : ${s.snaps === 0 ? C.r + '0 (none!)' + C.x : s.snaps}`);
  info(`seq max      : ${s.max_seq}   last snapshot at seq: ${s.snap_seq}`);
  const lagMb = s.lag_bytes / 1048576;
  const lagTxt = `${s.lag_events.toLocaleString('en-US')} events / ${fmtBytes(s.lag_bytes)}`;
  if (lagMb > LAG_MB_CRIT) ko(`lag: ${lagTxt}   ${C.r}(CRITICAL > ${LAG_MB_CRIT} MB)${C.x}`);
  else if (lagMb > LAG_MB_WARN) warn(`lag: ${lagTxt}   ${C.y}(warn > ${LAG_MB_WARN} MB)${C.x}`);
  else ok(`lag: ${lagTxt}`);
  info(dim("the 'lag' is what EVERY state load re-reads (getEventsSinceSnapshot / getEvents)"));

  head('BREAKDOWN BY TYPE');
  const types = db
    .prepare(
      `SELECT event_type AS t, COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b
         FROM events WHERE session_id=?
        GROUP BY event_type ORDER BY b DESC LIMIT 12`
    )
    .all(s.id);
  for (const r of types) {
    const pct = s.bytes ? ((r.b / s.bytes) * 100).toFixed(1) : '0.0';
    console.log(
      '  ' +
        padL(r.n.toLocaleString('en-US'), 9) +
        '  ' +
        padL(fmtBytes(r.b), 10) +
        '  ' +
        padL(pct + '%', 7) +
        '  ' +
        (pct > 50 ? C.r + r.t + C.x : r.t)
    );
  }

  head('O(n^2) SIGNATURE ON tool.preparing');
  try {
    const tp = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b,
                COUNT(DISTINCT json_extract(payload,'$.messageId')) AS mids
           FROM events WHERE session_id=? AND event_type='tool.preparing'`
      )
      .get(s.id);
    if (tp.n > 0) {
      const ideal = db
        .prepare(
          `SELECT COUNT(*) AS appels, COALESCE(SUM(mx),0) AS b FROM (
             SELECT MAX(LENGTH(payload)) AS mx FROM events
              WHERE session_id=? AND event_type='tool.preparing'
              GROUP BY json_extract(payload,'$.messageId'))`
        )
        .get(s.id);
      const factor = ideal.b ? tp.b / ideal.b : 0;
      info(`real tool calls       : ${ideal.appels}`);
      info(`tool.preparing events : ${tp.n.toLocaleString('en-US')}  (${(tp.n / Math.max(1, ideal.appels)).toFixed(0)} fragments per call)`);
      info(`stored                : ${fmtBytes(tp.b)}`);
      info(`needed (1 event/call) : ${fmtBytes(ideal.b)}`);
      if (factor > 5) ko(`bloat: ${C.r}${factor.toFixed(0)}\u00d7${C.x}   wasted: ${fmtBytes(tp.b - ideal.b)}`);
      else ok(`bloat: ${factor.toFixed(1)}\u00d7`);
      info(dim("cause: each streaming fragment of the arguments rewrites the ACCUMULATED JSON (quadratic curve)"));
    } else {
      ok('no tool.preparing events in this session');
    }
  } catch (e) {
    warn(`analysis failed: ${e.message}`);
  }

  head('SNAPSHOTS');
  const snaps = db
    .prepare(
      `SELECT seq, timestamp, LENGTH(payload) AS b FROM events
        WHERE session_id=? AND event_type='turn.snapshot' ORDER BY seq`
    )
    .all(s.id);
  if (snaps.length === 0) {
    ko('no snapshot: getEventsSinceSnapshot() falls back to a FULL scan (getEvents without fromSeq)');
  } else {
    for (const r of snaps.slice(-6)) {
      info(`seq ${padL(r.seq, 8)}  ${padL(fmtBytes(r.b), 10)}  ${new Date(r.timestamp).toISOString()}`);
    }
    if (snaps.length > 6) info(dim(`… and ${snaps.length - 6} older ones`));
    const coverage = s.max_seq ? ((s.snap_seq / s.max_seq) * 100).toFixed(1) : '0';
    if (s.lag_events > 0 && s.snap_seq < s.max_seq) {
      info('');
      info(`the last snapshot covers ${coverage}% of the history in seq`);
      info(dim("when the snapshot is far behind, getEvents(fromSeq) costs almost as much as a full scan"));
    }
  }

  if (!fast) {
    head("COST OF A STATE LOAD (measured)");
    const t = (label, fn) => {
      const t0 = process.hrtime.bigint();
      const r = fn();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log('  ' + pad(label, 46) + padL(ms.toFixed(1) + ' ms', 12));
      return r;
    };
    t('getLatestSnapshot()', () =>
      db
        .prepare(
          `SELECT * FROM events WHERE session_id=? AND event_type='turn.snapshot' ORDER BY seq DESC LIMIT 1`
        )
        .get(s.id)
    );
    t('getLatestSnapshotSeq()', () =>
      db
        .prepare(`SELECT seq FROM events WHERE session_id=? AND event_type='turn.snapshot' ORDER BY seq DESC LIMIT 1`)
        .get(s.id)
    );
    t('getNextSeq()  [on every append]', () =>
      db.prepare(`SELECT MAX(seq) AS m FROM events WHERE session_id=?`).get(s.id)
    );
    t('getEvents(no fromSeq)  [FULL SCAN]', () =>
      db.prepare(`SELECT e.* FROM events e WHERE e.session_id=? ORDER BY e.seq`).all(s.id)
    );
    t('getEvents(fromSeq = snapshot + 1)', () =>
      db.prepare(`SELECT e.* FROM events e WHERE e.session_id=? AND e.seq>=? ORDER BY e.seq`).all(s.id, s.snap_seq + 1)
    );
    info('');
    info(dim("these calls are SYNCHRONOUS: better-sqlite3 blocks the main thread for the whole duration"));
  }

  head('HOURLY GROWTH');
  const growth = db
    .prepare(
      `SELECT strftime('%m-%d %Hh', timestamp/1000, 'unixepoch') AS h,
              COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b
         FROM events WHERE session_id=?
        GROUP BY h ORDER BY MAX(timestamp) DESC LIMIT 10`
    )
    .all(s.id);
  for (const r of growth.reverse()) {
    console.log('  ' + pad(r.h, 12) + padL(r.n.toLocaleString('en-US'), 9) + '  ' + padL(fmtBytes(r.b), 10));
  }

  db.close();
  console.log('');
  info(dim(`next: ofx plan ${shortId(s.id)}`));
  console.log('');
}

// ---------------------------------------------------------------------------
// Command: plan (dry-run — never writes)
// ---------------------------------------------------------------------------
function cmdPlan(argv) {
  const selector = selectorOf(argv);
  if (!selector) fail('usage: ofx plan <id|--hot>', 1);

  const db = openDb();
  const rows = sessionMetrics(db);
  const s = resolveSession(rows, selector);

  const initRows = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id=? AND event_type='session.initialized'`)
    .get(s.id);
  const keepRows = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b FROM events
        WHERE session_id=? AND seq > 1 AND seq < ?
          AND event_type NOT IN (${CLEANUP_KEEP_TYPES.map(() => '?').join(',')})`
    )
    .get(s.id, s.snap_seq, ...CLEANUP_KEEP_TYPES);
  const newestSnap = db
    .prepare(
      `SELECT COALESCE(MAX(LENGTH(payload)),0) AS b FROM events
        WHERE session_id=? AND event_type='turn.snapshot'`
    )
    .get(s.id);

  console.log('');
  console.log(`  ${C.b}ofx plan${C.x}  ${dim('DRY-RUN MODE — no write, no modification')}`);
  console.log('');
  console.log(`  session: ${s.id}`);
  console.log(`  title  : ${s.title || dim('(untitled)')}`);
  console.log('');
  console.log(`  current state: ${s.n.toLocaleString('en-US')} events / ${fmtBytes(s.bytes)}  |  lag ${fmtBytes(s.lag_bytes)}`);
  rule();

  // --- 1. eligibility for the official consolidation ---
  console.log('');
  console.log('  ' + C.b + "1. ELIGIBILITY FOR CONSOLIDATION (EventStore.consolidateSession)" + C.x);
  console.log('');
  const el = consolidationEligibility(s);
  if (el.eligible) {
    ok('session consolidable at the next server startup');
  } else if (el.eligibleAfterRestart) {
    ok('consolidable after the next server restart');
    info(dim('the restart alone clears the blocker:'));
    for (const r of el.auto) info('\u2022 ' + r);
  } else {
    ko("NOT consolidable as-is — blockers:");
    for (const r of el.blocking) info('\u2022 ' + r);
    if (el.auto.length) {
      info('');
      info(dim('in addition (cleared by a restart):'));
      for (const r of el.auto) info('\u2022 ' + r);
    }
  }
  info('');
  info(dim("reminder from the code: findOrphanedSessions() requires is_running = 0 AND updated_at < now - 5 min."));
  info(dim("initEventStore() forces is_running = 0 on ALL sessions at startup."));

  // --- 2. impact of the consolidation ---
  console.log('');
  console.log('  ' + C.b + '2. IMPACT OF THE CONSOLIDATION' + C.x);
  console.log('');
  const deleted = Math.max(0, s.n - initRows.n);
  info(`events deleted          : ${deleted.toLocaleString('en-US')}  (everything except session.initialized ×${initRows.n})`);
  info(`data removed from rows : ${fmtBytes(s.bytes)}`);
  info(dim('  the FILE will not shrink on its own: SQLite keeps the pages in the freelist.'));
  info(dim('  only a VACUUM (openfox-vacuum.cjs) returns this space to the system.'));
  info(`lines remaining         : ${1 + initRows.n}  (1 new snapshot)`);
  info(`reference snapshot      : ${fmtBytes(newestSnap.b)}  (${dim('the new one should be of the same order')})`);
  info('');
  info('what SURVIVES (copied into the new snapshot by buildSnapshot):');
  info(dim('  messages, mode, phase, criteria, todos, readFiles, contextState,'));
  info(dim('  currentContextWindowId, contextWindows, metadataEntries, stats, titles…'));
  info('');
  info('what DISAPPEARS for good:');
  info(dim('  the raw deltas — tool.preparing, message.thinking, tool.output,'));
  info(dim('  tool.call, tool.result, chat.done. No granular replay possible anymore.'));
  if (s.is_running) {
    info('');
    warn("the session is RUNNING: a restart TERMINATES the current turn (in-flight work lost)");
  }

  // --- 3. impact of the routine purge ---
  console.log('');
  console.log('  ' + C.b + '3. IMPACT OF THE ROUTINE PURGE (cleanupOldEvents, after each turn)' + C.x);
  console.log('');
  if (s.snap_seq <= 1) {
    info(dim('without a recent snapshot, cleanupOldEvents() deletes nothing (seq > 1 AND seq < snapshotSeq)'));
  } else {
    info(`purgeable right now: ${keepRows.n.toLocaleString('en-US')} events / ${fmtBytes(keepRows.b)}`);
    info(dim('  = seq > 1 AND seq < snapshotSeq AND type not in the allowlist'));
    info(dim('  ⚠ does NOT touch the lag: everything after the snapshot is kept'));
    info('');
    info(dim("that is why the routine purge does NOT solve your problem:"));
    info(dim('the turn never ends -> no new snapshot -> nothing to purge.'));
  }

  // --- 4. what to do ---
  console.log('');
  console.log('  ' + C.b + '4. NEXT STEPS' + C.x);
  console.log('');
  if (el.eligible || el.eligibleAfterRestart) {
    info('to apply:');
    info(dim(`  ofx compact ${shortId(s.id)} --apply --restart`));
    info('');
    info(dim('(--apply backs up the database THEN stops the session; --restart restarts the service,'));
    info(dim(' which consolidates by itself at startup — we do not replay the fold by hand.)'));
    if (s.is_running) {
      info('');
      info(dim("stopping the session goes through the API: its caches stay coherent."));
    }
  } else {
    info('clear the blockers listed in 1., then run this plan again.');
    const waitReason = el.reasons.find((r) => r.includes('wait'));
    if (waitReason) {
      info('');
      info(dim('if the only blocker is the 5-minute delay: wait, then restart the service.'));
    }
  }
  console.log('');
  info(dim(`measurable trade-off: see ofx inspect ${shortId(s.id)}`));
  console.log('');

  db.close();
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------
async function cmdStatus() {
  console.log('');
  console.log(`  ${C.b}ofx status${C.x}`);
  rule();

  // --- systemd service ---
  console.log('');
  console.log('  ' + C.b + 'SERVICE' + C.x);
  const active = spawnSync('systemctl', ['is-active', SERVICE], { encoding: 'utf8' });
  const enabled = spawnSync('systemctl', ['is-enabled', SERVICE], { encoding: 'utf8' });
  const unitPath = `/etc/systemd/system/${SERVICE}.service`;
  const a = (active.stdout || '').trim();
  if (a === 'active') ok(`systemd: ${C.g}active${C.x}   (${(enabled.stdout || '').trim() || '?'})`);
  else warn(`systemd: ${a || 'unknown'}   (${(enabled.stdout || '').trim() || '?'})`);
  if (fs.existsSync(unitPath)) {
    info(dim(unitPath));
    try {
      const u = fs.readFileSync(unitPath, 'utf8');
      const rs = /^Restart=(.+)$/m.exec(u);
      const hm = /--max-old-space-size=(\d+)/.exec(u);
      if (rs) info(`Restart=${rs[1].trim()}${hm ? `   V8 ceiling = ${(Number(hm[1]) / 1024).toFixed(0)} GB` : ''}`);
    } catch {
      /* unreadable without permissions */
    }
  } else {
    info(dim(`no ${unitPath} — launched manually?`));
  }

  // --- process ---
  console.log('');
  console.log('  ' + C.b + 'PROCESS' + C.x);
  const procs = openfoxProcesses();
  if (procs.length === 0) warn('no OpenFox process detected');
  for (const p of procs) {
    console.log(
      '  ' +
        `pid ${pad(p.pid, 9)} ${padL(fmtBytes(p.rss), 10)}` +
        (p.heapMb ? `  ceiling ${(p.heapMb / 1024).toFixed(0)} GB` : '') +
        (p.rss === Math.max(...procs.map((x) => x.rss)) ? C.d + '   ← server' + C.x : '')
    );
  }

  // --- API ---
  console.log('');
  console.log('  ' + C.b + 'API' + C.x);
  const h = await apiHealth();
  if (!h) warn(`unreachable: ${API_BASE}`);
  else {
    ok(`online: ${API_BASE}  (${h.status})`);
    try {
      const r = await apiFetch('/api/auth', { timeoutMs: 4000 });
      const j = await r.json();
      if (j.requiresAuth) {
        info(`authentication required (${j.hasPassword ? 'password set' : 'no password'})`);
        const src = credentialSource();
        if (src) info(dim(`   credentials found (${src.label}): tier 2 available`));
        else info(dim('   no credentials: tier 2 unavailable (tier 1 OK)'));
      } else {
        info('no authentication required: tier 2 available without a token');
      }
    } catch {
      /* ignore */
    }
  }

  // --- database ---
  console.log('');
  console.log('  ' + C.b + 'DATABASE' + C.x);
  if (!fs.existsSync(DB_PATH)) {
    warn(`not found: ${DB_PATH}`);
  } else {
    const st = fs.statSync(DB_PATH);
    let wal = 0;
    try {
      wal = fs.statSync(DB_PATH + '-wal').size;
    } catch {
      /* no wal */
    }
    ok(`${DB_PATH}`);
    info(`size ${fmtBytes(st.size)}   wal ${fmtBytes(wal)}   updated ${st.mtime.toISOString()}`);
    const holders = findHolders(DB_PATH);
    if (holders.length === 0) info('no process holds the database (offline operations possible)');
    else for (const hp of holders) info(`held by pid ${hp.pid} — ${hp.cmd.slice(0, 70)}`);

    const db = openDb();
    const rows = sessionMetrics(db);
    db.close();
    const lag = rows.reduce((x, r) => x + r.lag_bytes, 0);
    const worst = [...rows].sort((x, y) => y.lag_bytes - x.lag_bytes)[0];
    const running = rows.filter((r) => r.is_running);
    console.log('');
    info(`sessions ${rows.length}   running ${running.length}   cumulative lag ${fmtBytes(lag)}`);
    if (worst && worst.lag_bytes > 0) {
      const m = worst.lag_bytes / 1048576;
      const msg = `worst session ${shortId(worst.id)}: ${fmtBytes(worst.lag_bytes)}`;
      if (m > LAG_MB_CRIT) ko(msg + `   (CRITICAL > ${LAG_MB_CRIT} MB)`);
      else if (m > LAG_MB_WARN) warn(msg + `   (warn > ${LAG_MB_WARN} MB)`);
      else info(msg);
    }
    for (const r of running) {
      const ageMs = Date.parse(r.updated_at) ? Date.now() - Date.parse(r.updated_at) : null;
      warn(
        `session ${shortId(r.id)} marked RUNNING — updated ${fmtAge(ageMs)}` +
          (ageMs != null && ageMs > 10 * 60 * 1000 ? C.d + '  (probably a ghost)' + C.x : '')
      );
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Tier 2: API actions
// ---------------------------------------------------------------------------
async function cmdApiAction(action, argv) {
  const selector = selectorOf(argv);
  if (!selector) fail(`usage: ofx ${action} <id>`, 1);

  const db = openDb();
  const rows = sessionMetrics(db);
  const s = resolveSession(rows, selector);
  db.close();

  const token = requireTokenOrExplain(await apiToken());

  console.log('');
  console.log(`  ${C.b}ofx ${action}${C.x}  ${shortId(s.id)}  ${dim(s.title || '')}`);
  console.log('');

  let r;
  try {
    r = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/${action}`, { method: 'POST', token });
  } catch (e) {
    fail(`API call failed: ${e.message}`, 2);
  }
  const text = await r.text();
  if (r.status === 404) fail('session unknown to the server (it exists in the database but not in memory)', 2);
  if (r.status === 401 || r.status === 403) fail(`authentication rejected (HTTP ${r.status}) — check OPENFOX_TOKEN/OPENFOX_PASSWORD`, 1);
  if (r.status === 409) fail(`conflict (HTTP 409): incompatible state — ${text.slice(0, 200)}`, 2);
  if (!r.ok) fail(`failed (HTTP ${r.status}): ${text.slice(0, 300)}`, 2);

  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  ok(`${action} \u2192 HTTP ${r.status}${j.success ? ' success' : ''}`);
  if (j.queuedMessages && j.queuedMessages.length) info(`${j.queuedMessages.length} message(s) removed from the queue`);
  console.log('');
  info(dim('this action goes through the server: its snapshot/prompts caches stay coherent.'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Tier 3: compact (orchestrator — does NOT replay the fold)
// ---------------------------------------------------------------------------
async function cmdCompact(argv) {
  const selector = selectorOf(argv);
  if (!selector) fail('usage: ofx compact <id|--hot> [--apply] [--restart] [--yes]', 1);
  const apply = argv.includes('--apply');
  const restart = argv.includes('--restart');
  const assumeYes = argv.includes('--yes');

  if (!apply) {
    console.log('');
    console.log(`  ${C.b}ofx compact${C.x}  ${C.y}without --apply: plan mode, no modification${C.x}`);
    // Reuses the plan command to avoid duplicating the logic.
    return cmdPlan(argv);
  }

  const db = openDb();
  const rows = sessionMetrics(db);
  const s = resolveSession(rows, selector);
  db.close();

  console.log('');
  console.log(`  ${C.b}ofx compact --apply${C.x}  ${s.id}`);
  console.log('');
  console.log('  What this command will do:');
  console.log('   1. back up the database (mandatory — we abort if the backup fails)');
  console.log("   2. stop the session via the API if it is running");
  console.log('   3. restart the service (if --restart), which consolidates by itself at startup');
  console.log('');
  console.log('  What it will NOT do: replay the fold, delete rows, touch the seq numbers.');
  console.log('');

  // Pre-check: no point backing up 700 MB if consolidation is impossible anyway
  // (for example updated_at too recent after stopping the session).
  const pre = consolidationEligibility(s);
  if (!(pre.eligible || pre.eligibleAfterRestart)) {
    ko("consolidation impossible as-is — blockers:");
    for (const r of pre.blocking) info('\u2022 ' + r);
    console.log('');
    info('no modification made (not even a backup).');
    info(dim(`run ofx plan ${shortId(s.id)} again once the blocker is cleared.`));
    console.log('');
    process.exit(1);
  }

  // Authentication pre-check: if the session is running, tier 2 is mandatory.
  // Checked BEFORE the backup, so as not to write 700 MB for nothing.
  let token = null;
  if (s.is_running) {
    token = await apiToken();
    if (!token) {
      ko("the session is running: stopping it via the API requires a token, and none is provided");
      console.log('');
      info('set OPENFOX_PASSWORD or OPENFOX_TOKEN, or stop the session from the UI:');
      info(dim(`  OPENFOX_PASSWORD='...' ofx compact ${shortId(s.id)} --apply --restart`));
      console.log('');
      info(dim('no modification made (not even a backup).'));
      console.log('');
      process.exit(1);
    }
  }

  if (!assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question('  Continue? (yes/no) ', res));
    rl.close();
    const a = String(answer).trim().toLowerCase();
    if (a !== 'oui' && a !== 'o' && a !== 'y' && a !== 'yes') {
      console.log('');
      info('cancelled — nothing has been modified.');
      console.log('');
      process.exit(0);
    }
  }

  // --- 1. MANDATORY backup ---
  console.log('');
  console.log('  ' + C.b + '1. BACKUP' + C.x);
  const backupScript = path.join(SCRIPT_DIR, 'openfox-backup.cjs');
  if (!fs.existsSync(backupScript)) fail(`backup impossible: ${backupScript} not found`, 1);
  const bk = spawnSync(process.execPath, [backupScript], { stdio: 'inherit' });
  if (bk.status !== 0) fail("the backup failed — operation cancelled (no modification made)", 2);
  ok('backup done');
  rule();

  // --- 2. stop the session via the API ---
  console.log('');
  console.log('  ' + C.b + '2. STOPPING THE SESSION' + C.x);
  const fresh = openDb();
  const fr = resolveSession(sessionMetrics(fresh), s.id);
  fresh.close();
  if (!fr.is_running) {
    ok('the session is already stopped');
  } else {
    if (!token) {
      ko('the session is running but no API token (checked in the pre-control)');
      process.exit(1);
    }
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/stop`, { method: 'POST', token });
      if (r.ok) ok('session stopped via POST /api/sessions/:id/stop');
      else warn(`stop rejected (HTTP ${r.status}) — continuing carefully`);
    } catch (e) {
      warn(`stop call failed: ${e.message}`);
    }
  }

  // --- 3. restart ---
  console.log('');
  console.log('  ' + C.b + '3. RESTART (triggers the consolidation)' + C.x);

  const again = openDb();
  const el = consolidationEligibility(resolveSession(sessionMetrics(again), s.id));
  again.close();
  if (!(el.eligible || el.eligibleAfterRestart)) {
    console.log('');
    ko('preconditions not met — restart NOT triggered:');
    for (const r of el.blocking) info('\u2022 ' + r);
    console.log('');
    info("the backup is done, nothing else has been modified.");
    info(dim('run ofx plan again once the blocker is cleared.'));
    console.log('');
    process.exit(1);
  }

  const cmd = `sudo systemctl stop ${SERVICE} && sleep 1 && sudo systemctl start ${SERVICE}`;
  if (!restart) {
    info('preconditions OK. To finish, run:');
    console.log('');
    console.log('    ' + C.b + cmd + C.x);
    console.log('');
    info(dim('or more simply: ofx service restart'));
    info(dim("restarting kills the current turn: that is the only real loss of the operation."));
    console.log('');
    return;
  }

  console.log(`  ${dim('$ ' + cmd)}`);
  console.log('');
  const rs = svcRestart();
  if (rs.status !== 0) {
    console.log('');
    ko(`restart failed (code ${rs.status}) — the database is backed up, nothing else changed`);
    info(dim('if sudo asks for a password, run the command in a terminal:'));
    info(dim('  ' + cmd));
    console.log('');
    process.exit(2);
  }
  ok('service restarted');

  // --- 4. verification ---
  console.log('');
  console.log('  ' + C.b + '4. VERIFICATION' + C.x);
  const before = fr.lag_bytes;
  const deadline = Date.now() + 90000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const h = await apiHealth();
    if (!h) continue;
    try {
      const v = openDb();
      last = resolveSession(sessionMetrics(v), s.id);
      v.close();
    } catch {
      continue;
    }
    if (last.lag_bytes < before) break;
    if (last.n < fr.n) break;
  }
  console.log('');
  if (!last) {
    warn('server not back yet — check with: ofx status');
  } else {
    const delta = fr.n - last.n;
    info(`events: ${fr.n.toLocaleString('en-US')} \u2192 ${last.n.toLocaleString('en-US')}  (${delta > 0 ? '-' + delta.toLocaleString('en-US') : '0'})`);
    info(`volume: ${fmtBytes(fr.bytes)} \u2192 ${fmtBytes(last.bytes)}`);
    info(`lag: ${fmtBytes(fr.lag_bytes)} \u2192 ${fmtBytes(last.lag_bytes)}`);
    console.log('');
    if (last.lag_bytes < before || last.n < fr.n) ok('consolidation done');
    else warn('no visible change — check the logs: journalctl -u ' + SERVICE + ' -n 80');
  }
  console.log('');
  info(dim(`recap: ofx inspect ${shortId(s.id)} --fast`));
  console.log('');
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// service — lifecycle (absorbed from openfox-ctl)
// ---------------------------------------------------------------------------
const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'status', 'install', 'upgrade'];

// MANDATORY and non-bypassable confirmation, reserved for the destructive commands.
// No --yes option: these commands run rm -rf, they must stay
// impossible to trigger from a script or by accident.
async function confirmDestructive(commands) {
  console.log('');
  console.log('  ' + C.y + C.b + 'This command will run:' + C.x);
  for (const l of commands) console.log('    ' + C.y + l + C.x);
  console.log('');
  if (!process.stdin.isTTY) {
    ko("interactive confirmation required, but stdin is not a terminal");
    info('these operations are destructive: they cannot be scripted.');
    info(dim('run the command from a terminal.'));
    console.log('');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question('  Continue? (yes/no) ', res));
  rl.close();
  const s = String(a).trim().toLowerCase();
  if (s !== 'oui' && s !== 'o' && s !== 'y' && s !== 'yes') {
    console.log('');
    info("cancelled — nothing was changed.");
    console.log('');
    process.exit(0);
  }
  console.log('');
}

async function cmdService(argv) {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const action = positional[0];

  if (!action) {
    printHelp('service');
    process.exit(1);
  }
  if (!SERVICE_ACTIONS.includes(action)) {
    console.log('');
    ko(`unknown action: ${action}`);
    info(`valid actions: ${SERVICE_ACTIONS.join(', ')}`);
    info(dim('help: ofx help service'));
    console.log('');
    process.exit(1);
  }

  if (action === 'status') return cmdServiceStatus(argv);
  if (action === 'install') return cmdServiceInstall(positional[1]);
  if (action === 'upgrade') return cmdServiceUpgrade();

  console.log('');
  if (action === 'start') {
    if (svcIsActive()) {
      ok(`already started (MainPID ${svcMainPid() || '?'})`);
      console.log('');
      return;
    }
    const r = svcDo('start');
    console.log('');
    if (r.status === 0 && svcIsActive()) ok(`started (MainPID ${svcMainPid() || '?'})`);
    else fail('start failed — see: ofx logs', 2);
    console.log('');
    return;
  }

  if (action === 'stop') {
    if (!svcIsActive()) {
      ok('already stopped');
      console.log('');
      return;
    }
    const r = svcDo('stop');
    console.log('');
    if (r.status === 0 && !svcIsActive()) ok('stopped');
    else fail("stop failed", 2);
    console.log('');
    return;
  }

  // restart: stop, one-second pause, start. The delay releases port 10369
  // and avoids the EADDRINUSE documented in the history of the original script.
  info("stop, one-second pause (releasing port " + PORT + '), then start');
  console.log('');
  svcRestart();
  console.log('');
  if (svcIsActive()) ok(`restarted (MainPID ${svcMainPid() || '?'})`);
  else fail('restart failed — see: ofx logs', 2);
  console.log('');
}

async function cmdServiceStatus(argv) {
  const noUpdate = argv.includes('--no-update-check');
  const inst = installedVersion();

  console.log('');
  console.log('  ' + C.b + 'ofx service status' + C.x);
  rule();

  console.log('');
  console.log('  ' + C.b + 'INSTALLATION' + C.x);
  info(`directory  : ${OPENFOX_DIR}`);
  info(`version    : ${inst}`);
  if (fs.existsSync(path.join(OPENFOX_DIR, 'lib/node_modules/openfox/package.json'))) ok('package present');
  else warn('package not found in this directory');

  console.log('');
  console.log('  ' + C.b + 'SERVICE' + C.x);
  if (svcIsActive()) {
    ok(`active (MainPID ${svcMainPid() || '?'})`);
    info(dim('MainPID designates the LAUNCHER; the server is its child (see ofx status)'));
  } else {
    ko('inactive');
  }
  info(`unit : ${SERVICE}   port : ${PORT}   access : http://localhost:${PORT}`);
  info(`journal : journalctl -u ${SERVICE}   |   file : ${LOG_FILE}`);

  const procs = openfoxProcesses();
  if (procs.length) {
    const maxRss = Math.max(...procs.map((x) => x.rss));
    console.log('');
    console.log('  ' + C.b + 'PROCESS' + C.x);
    for (const p of procs) {
      console.log(
        '  ' + `pid ${pad(p.pid, 9)} ${padL(fmtBytes(p.rss), 10)}` + (p.rss === maxRss ? C.d + '   \u2190 server' + C.x : '')
      );
    }
  }

  console.log('');
  console.log('  ' + C.b + 'JOURNAL (last 5 lines)' + C.x);
  const j = spawnSync('journalctl', ['-u', SERVICE, '-n', '5', '--no-pager'], { encoding: 'utf8' });
  const jl = (j.stdout || '').trim().split('\n').filter(Boolean);
  if (!jl.length) info(dim('(journal unavailable)'));
  else for (const l of jl) console.log('  ' + l.slice(0, 160));

  console.log('');
  if (noUpdate) {
    info(dim('update check skipped (--no-update-check)'));
  } else {
    try {
      const latest = await latestVersion();
      if (latest === inst) ok(`up to date (${inst})`);
      else {
        warn(`update available: ${inst} \u2192 ${C.b}${latest}${C.x}`);
        info(dim('to apply: ofx service upgrade'));
      }
    } catch (e) {
      warn(`version check failed: ${e.message}`);
      info(dim("requires access to api.github.com — use --no-update-check to skip it"));
    }
  }
  console.log('');
}

// Installer. Destructive: removes ${OPENFOX_DIR} before reinstalling.
async function cmdServiceInstall(versionArg) {
  let version = versionArg;
  if (!version) {
    try {
      version = await latestVersion();
    } catch (e) {
      fail(`cannot determine the latest version: ${e.message}`, 2);
    }
    console.log('');
    info(`no version requested: latest published = ${version}`);
  }

  console.log('');
  console.log('  ' + C.b + 'ofx service install' + C.x + `  version ${version}`);

  if (svcIsActive()) {
    console.log('');
    ko(`the service is ACTIVE: replacing ${OPENFOX_DIR} while it runs can corrupt it`);
    info('stop it first:');
    info(dim('  ofx service stop'));
    info(dim('or use ofx service upgrade, which handles the stop and the restart itself'));
    console.log('');
    process.exit(1);
  }

  const ug = userGroup();
  const steps = [];
  if (fs.existsSync(OPENFOX_DIR)) steps.push(`sudo rm -rf ${OPENFOX_DIR}`);
  steps.push(`sudo mkdir -p ${OPENFOX_DIR} && sudo chown -R ${ug} ${OPENFOX_DIR}`);
  steps.push(`npm install -g openfox@${version} --prefix=${OPENFOX_DIR}`);
  if (!fs.existsSync('/usr/local/bin/openfox')) {
    steps.push(`sudo ln -sf ${OPENFOX_DIR}/bin/openfox /usr/local/bin/openfox`);
  }
  steps.push(`sudo mkdir -p ${RUNTIME_DIR} && sudo chown -R ${ug} ${RUNTIME_DIR}`);
  await confirmDestructive(steps);

  const step = (label, cmd, args) => {
    console.log('  ' + C.d + '$ ' + label + C.x);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) fail(`failed: ${label}`, 2);
  };

  if (fs.existsSync(OPENFOX_DIR)) step(`sudo rm -rf ${OPENFOX_DIR}`, 'sudo', ['rm', '-rf', OPENFOX_DIR]);
  step(`sudo mkdir -p ${OPENFOX_DIR}`, 'sudo', ['mkdir', '-p', OPENFOX_DIR]);
  step(`sudo chown -R ${ug} ${OPENFOX_DIR}`, 'sudo', ['chown', '-R', ug, OPENFOX_DIR]);
  step(
    `npm install -g openfox@${version} --prefix=${OPENFOX_DIR}`,
    'npm',
    ['install', '-g', `openfox@${version}`, `--prefix=${OPENFOX_DIR}`]
  );
  if (!fs.existsSync('/usr/local/bin/openfox')) {
    step(
      `sudo ln -sf ${OPENFOX_DIR}/bin/openfox /usr/local/bin/openfox`,
      'sudo',
      ['ln', '-sf', path.join(OPENFOX_DIR, 'bin/openfox'), '/usr/local/bin/openfox']
    );
  }
  step(`sudo mkdir -p ${RUNTIME_DIR}`, 'sudo', ['mkdir', '-p', RUNTIME_DIR]);
  step(`sudo chown -R ${ug} ${RUNTIME_DIR}`, 'sudo', ['chown', '-R', ug, RUNTIME_DIR]);

  console.log('');
  const v = installedVersion();
  if (v === version) ok(`OpenFox ${version} installed in ${OPENFOX_DIR}`);
  else warn(`installation finished, but the version read back is ${v} (expected ${version})`);
  info(dim('to start: ofx service start'));
  console.log('');
}

// Upgrade. Destructive. Stops the service if it was running, reinstalls it, restarts it.
async function cmdServiceUpgrade() {
  const inst = installedVersion();
  let latest;
  try {
    latest = await latestVersion();
  } catch (e) {
    fail(`cannot fetch the latest version: ${e.message}`, 2);
  }

  console.log('');
  console.log('  ' + C.b + 'ofx service upgrade' + C.x + `  ${inst} \u2192 ${latest}`);

  if (inst === latest) {
    console.log('');
    ok(`already up to date (${inst})`);
    console.log('');
    return;
  }

  const wasRunning = svcIsActive();
  const ug = userGroup();
  const steps = [];
  if (wasRunning) steps.push(`sudo systemctl stop ${SERVICE}`);
  steps.push(`sudo rm -rf ${OPENFOX_DIR}`);
  steps.push(`sudo mkdir -p ${OPENFOX_DIR} && sudo chown -R ${ug} ${OPENFOX_DIR}`);
  steps.push(`npm install -g openfox@${latest} --prefix=${OPENFOX_DIR}`);
  if (wasRunning) steps.push(`sudo systemctl start ${SERVICE}`);

  console.log('');
  warn("the current installation is removed before the reinstall: if npm fails,");
  warn(`nothing runs anymore — then reinstall with: ofx service install ${inst}`);
  if (wasRunning) info(`the service is active: it will be stopped then restarted (${SERVICE})`);

  await confirmDestructive(steps);

  const step = (label, cmd, args) => {
    console.log('  ' + C.d + '$ ' + label + C.x);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) fail(`failed: ${label}`, 2);
  };

  if (wasRunning) step(`sudo systemctl stop ${SERVICE}`, 'sudo', ['systemctl', 'stop', SERVICE]);
  step(`sudo rm -rf ${OPENFOX_DIR}`, 'sudo', ['rm', '-rf', OPENFOX_DIR]);
  step(`sudo mkdir -p ${OPENFOX_DIR}`, 'sudo', ['mkdir', '-p', OPENFOX_DIR]);
  step(`sudo chown -R ${ug} ${OPENFOX_DIR}`, 'sudo', ['chown', '-R', ug, OPENFOX_DIR]);
  step(
    `npm install -g openfox@${latest} --prefix=${OPENFOX_DIR}`,
    'npm',
    ['install', '-g', `openfox@${latest}`, `--prefix=${OPENFOX_DIR}`]
  );
  if (wasRunning) step(`sudo systemctl start ${SERVICE}`, 'sudo', ['systemctl', 'start', SERVICE]);

  console.log('');
  const v = installedVersion();
  if (v === latest) ok(`OpenFox ${latest} installed`);
  else warn(`version read: ${v} (expected ${latest})`);
  if (wasRunning) {
    spawnSync('sleep', ['2']);
    if (svcIsActive()) ok(`service restarted (MainPID ${svcMainPid() || '?'})`);
    else warn('the service does not seem active — see: ofx logs');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// logs — service journal
// ---------------------------------------------------------------------------
function cmdLogs(argv) {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const follow = argv.includes('-f') || argv.includes('--follow');
  const nArg = Number(positional[0]);
  const n = Number.isFinite(nArg) && nArg > 0 ? nArg : 20;

  console.log('');
  if (follow) {
    info(`following the ${SERVICE} journal — Ctrl+C to stop`);
    console.log('  ' + C.d + '\u2500'.repeat(72) + C.x);
    const r = spawnSync('journalctl', ['-u', SERVICE, '-f'], { stdio: 'inherit' });
    if (r.error || (r.status !== null && r.status !== 0 && r.status !== 130)) {
      if (fs.existsSync(LOG_FILE)) {
        warn('journalctl unavailable — falling back to the log file');
        spawnSync('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
      } else {
        fail(`no journal available (neither journalctl nor ${LOG_FILE})`, 2);
      }
    }
    return;
  }

  info(`last ${n} lines of the ${SERVICE} journal`);
  console.log('  ' + C.d + '\u2500'.repeat(72) + C.x);
  const r = spawnSync('journalctl', ['-u', SERVICE, '-n', String(n), '--no-pager'], {
    encoding: 'utf8',
  });
  if (r.status === 0 && (r.stdout || '').trim()) {
    process.stdout.write(r.stdout);
  } else if (fs.existsSync(LOG_FILE)) {
    warn('journalctl unavailable — falling back to the log file');
    spawnSync('tail', ['-n', String(n), LOG_FILE], { stdio: 'inherit' });
  } else {
    warn('no journal available');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// auth — ofx credentials (masked input, 600 storage)
// ---------------------------------------------------------------------------
const AUTH_ACTIONS = ['login', 'set-token', 'status', 'check', 'clear'];

async function cmdAuth(argv) {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const action = positional[0];

  if (!action) {
    printHelp('auth');
    process.exit(1);
  }
  if (!AUTH_ACTIONS.includes(action)) {
    console.log('');
    ko(`unknown action: ${action}`);
    info(`valid actions: ${AUTH_ACTIONS.join(', ')}`);
    info(dim('help: ofx help auth'));
    console.log('');
    process.exit(1);
  }

  if (action === 'status') return cmdAuthStatus();
  if (action === 'clear') return cmdAuthClear();
  if (action === 'check') return cmdAuthCheck();
  if (action === 'login') return cmdAuthLogin();
  return cmdAuthSetToken(argv.includes('--no-verify'));
}

async function cmdAuthStatus() {
  console.log('');
  console.log('  ' + C.b + 'ofx auth status' + C.x);
  rule();

  console.log('');
  console.log('  ' + C.b + 'API' + C.x);
  const h = await apiHealth();
  let authRequired = null;
  if (!h) {
    ko(`unreachable: ${API_BASE}`);
    info(dim("actions and compact --apply need it; tier 1 (read) does not"));
  } else {
    ok(`online: ${API_BASE}`);
    try {
      const r = await apiFetch('/api/auth', { timeoutMs: 4000 });
      const j = await r.json();
      authRequired = Boolean(j.requiresAuth);
      if (!authRequired) {
        info("no authentication required: tier 2 is available without a token");
      } else {
        info(`authentication required (${j.hasPassword ? 'password set' : 'no password set'})`);
        if (!j.hasPassword) warn("login will fail: set a password from the OpenFox interface");
      }
    } catch {
      /* /api/auth unavailable */
    }
  }

  console.log('');
  console.log('  ' + C.b + 'SOURCES' + C.x);
  const envTok = process.env.OPENFOX_TOKEN;
  const envPwd = process.env.OPENFOX_PASSWORD;
  const f = readTokenFile();
  const hasFile = Boolean(f && f.value);

  const mark = (used) => '  ' + (used ? C.g + '\u2713' + C.x : C.d + '\u00b7' + C.x) + ' ';
  console.log(mark(Boolean(envTok)) + `OPENFOX_TOKEN (env): ` + (envTok ? fingerprint(envTok) : dim('not set')));
  console.log(
    mark(hasFile) +
      `file ${OFX_TOKEN_FILE}: ` +
      (f ? (hasFile ? fingerprint(f.value) + `  permissions ${f.perms}` : dim('present but empty')) : dim('absent'))
  );
  console.log(
    mark(Boolean(envPwd)) +
      'OPENFOX_PASSWORD (env): ' +
      (envPwd ? dim('set — exchanged for a token on every call') : dim('not set'))
  );

  console.log('');
  const used = credentialSource();
  if (used) info(`ofx will use: ${C.b}${used.label}${C.x}`);
  else info(dim('no credentials available — only read commands will work'));

  if (hasFile && f.mode !== 0o600) {
    console.log('');
    warn(`permissions too wide on ${OFX_TOKEN_FILE} (${f.perms}, expected 600)`);
    info(dim(`fix: chmod 600 ${OFX_TOKEN_FILE}`));
  }
  if (hasFile) {
    console.log('');
    info(dim(`stored ${fmtAge(Date.now() - f.mtime)} — deterministic, no expiry`));
  }
  if (!used && authRequired) {
    console.log('');
    info(`to store a token: ${C.b}ofx auth login${C.x}`);
  }
  console.log('');
}

function cmdAuthClear() {
  console.log('');
  const f = readTokenFile();
  if (!f) {
    info(`no token file: ${OFX_TOKEN_FILE}`);
    console.log('');
    return;
  }
  try {
    fs.unlinkSync(OFX_TOKEN_FILE);
  } catch (e) {
    fail(`cannot delete: ${e.message}`, 2);
  }
  ok(`deleted: ${OFX_TOKEN_FILE}`);
  console.log('');
  if (process.env.OPENFOX_TOKEN || process.env.OPENFOX_PASSWORD) {
    info(dim('warning: OPENFOX_TOKEN / OPENFOX_PASSWORD are still set in this environment'));
  } else {
    info(dim('no credential stored by ofx any more'));
  }
  console.log('');
}

async function cmdAuthCheck() {
  console.log('');
  const f = readTokenFile();
  const token = await apiToken();
  if (!token) {
    ko('no credentials available (no OPENFOX_TOKEN, no file, no OPENFOX_PASSWORD)');
    info(`store one: ${C.b}ofx auth login${C.x}`);
    console.log('');
    process.exit(1);
  }
  const source = process.env.OPENFOX_TOKEN
    ? 'OPENFOX_TOKEN'
    : f && f.value === token
      ? 'token file'
      : 'OPENFOX_PASSWORD';

  let r;
  try {
    r = await apiFetch('/api/sessions', { token, timeoutMs: 8000 });
  } catch (e) {
    fail(`verification impossible: ${e.message}`, 2);
  }

  if (r.ok) {
    ok(`valid credentials — source: ${source}, ${fingerprint(token)}`);
    console.log('');
    return;
  }
  if (r.status === 401 || r.status === 403) {
    ko(`credentials REJECTED (HTTP ${r.status}) — source: ${source}`);
    info(dim('the token no longer matches the password, or auth.key was regenerated'));
    info(`regenerate it: ${C.b}ofx auth login${C.x}`);
    console.log('');
    process.exit(2);
  }
  warn(`unexpected response: HTTP ${r.status}`);
  console.log('');
  process.exit(2);
}

async function cmdAuthLogin() {
  console.log('');
  console.log('  ' + C.b + 'ofx auth login' + C.x);
  console.log('');

  const h = await apiHealth();
  if (!h) fail(`API unreachable: ${API_BASE}`, 2);

  let authRequired = true;
  try {
    const r = await apiFetch('/api/auth', { timeoutMs: 4000 });
    const j = await r.json();
    authRequired = Boolean(j.requiresAuth);
    if (!j.hasPassword) {
      ko("no password is set on the OpenFox side: login is impossible");
      info(dim("set one from the OpenFox interface, then run this command again"));
      console.log('');
      process.exit(1);
    }
  } catch (e) {
    fail(`cannot read /api/auth: ${e.message}`, 2);
  }
  if (!authRequired) {
    ok("the API requires no authentication");
    info(dim("nothing to store: action commands work without a token"));
    console.log('');
    return;
  }

  console.log('  ' + dim('The password is only used to obtain the token: ofx does not store it.'));
  console.log('  ' + dim("Input is masked and does not go into the shell history."));
  console.log('');

  let pwd;
  try {
    pwd = await promptHidden('  OpenFox password: ');
  } catch (e) {
    fail(e.message, 1);
  }
  if (!pwd) {
    console.log('');
    ko('empty password');
    console.log('');
    process.exit(1);
  }

  let token = null;
  try {
    const r = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: { password: pwd },
      timeoutMs: 10000,
    });
    if (r.status === 401) {
      console.log('');
      ko('password rejected (HTTP 401)');
      console.log('');
      process.exit(1);
    }
    if (r.status === 400) {
      console.log('');
      ko("authentication not configured on the OpenFox side (HTTP 400)");
      console.log('');
      process.exit(1);
    }
    if (!r.ok) {
      console.log('');
      ko(`login failed (HTTP ${r.status})`);
      console.log('');
      process.exit(2);
    }
    const j = await r.json();
    token = j.token || null;
  } catch (e) {
    fail(`login call failed: ${e.message}`, 2);
  } finally {
    // We drop the reference to the password as soon as it is no longer useful.
    // (In JavaScript an already allocated string cannot be erased: this is a
    // precaution, not a guarantee.)
    pwd = null;
  }

  if (!token) fail("the server did not return a token", 2);

  // Verification BEFORE writing: an untested token written to disk is worse
  // than no token at all, because it fails later and somewhere else.
  let check;
  try {
    check = await apiFetch('/api/sessions', { token, timeoutMs: 8000 });
  } catch (e) {
    fail(`token verification impossible: ${e.message}`, 2);
  }
  if (!check.ok) {
    console.log('');
    ko(`the returned token does not work (HTTP ${check.status}) — nothing was stored`);
    console.log('');
    process.exit(2);
  }
  ok('token obtained and verified');

  try {
    writeTokenFile(token);
  } catch (e) {
    fail(`cannot write ${OFX_TOKEN_FILE}: ${e.message}`, 2);
  }
  console.log('');
  ok(`stored in ${OFX_TOKEN_FILE} (permissions 600, ${fingerprint(token)})`);
  console.log('');
  info(dim('ofx will find it on its own: nothing left to export'));
  info(dim('to verify: ofx auth check'));
  console.log('');
}

async function cmdAuthSetToken(noVerify) {
  console.log('');
  console.log('  ' + C.b + 'ofx auth set-token' + C.x);
  console.log('');
  console.log('  ' + dim("Paste the token then press Enter. Input is masked (with '*')."));
  console.log('');

  let token;
  try {
    token = await promptHidden('  Token: ');
  } catch (e) {
    fail(e.message, 1);
  }
  token = String(token || '').trim();
  if (!token) {
    console.log('');
    ko('empty token');
    console.log('');
    process.exit(1);
  }

  if (!noVerify) {
    const h = await apiHealth();
    if (!h) fail(`API unreachable: ${API_BASE} — cannot verify the token`, 2);
    let r;
    try {
      r = await apiFetch('/api/sessions', { token, timeoutMs: 8000 });
    } catch (e) {
      fail(`verification impossible: ${e.message}`, 2);
    }
    if (!r.ok) {
      console.log('');
      if (r.status === 401 || r.status === 403) ko(`token rejected (HTTP ${r.status}) — nothing was stored`);
      else ko(`verification impossible (HTTP ${r.status}) — nothing was stored`);
      console.log('');
      process.exit(1);
    }
    ok('valid token');
  } else {
    warn('verification skipped (--no-verify): the token will be stored without being tested');
  }

  try {
    writeTokenFile(token);
  } catch (e) {
    fail(`cannot write ${OFX_TOKEN_FILE}: ${e.message}`, 2);
  }
  console.log('');
  ok(`stored in ${OFX_TOKEN_FILE} (permissions 600, ${fingerprint(token)})`);
  console.log('');
}

// ---------------------------------------------------------------------------
// export — export a session (read-only)
// ---------------------------------------------------------------------------
async function cmdExport(argv) {
  const FLAGS = ['-o', '--out'];
  const selector = selectorOf(argv, FLAGS);
  if (!selector) fail('usage: ofx export <id|--hot> [-o file]', 1);
  const pos = positionalOf(argv, FLAGS);
  let explicit = optValue(argv, FLAGS);
  if (pos.includes('-')) explicit = '-';

  const db = openDb();
  const rows = sessionMetrics(db);
  const s = resolveSession(rows, selector);
  db.close();

  const token = requireTokenOrExplain(await apiToken());

  console.log('');
  console.log(`  ${C.b}ofx export${C.x}  ${shortId(s.id)}  ${dim(String(s.title || '').slice(0, 50))}`);
  console.log('');
  info(`${s.n.toLocaleString('en-US')} events in the database / ${fmtBytes(s.bytes)}`);

  let r;
  try {
    r = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}/export`, { token, timeoutMs: 120000 });
  } catch (e) {
    fail(`API call failed: ${e.message}`, 2);
  }
  if (r.status === 404) {
    fail("session unknown to the server: it exists in the database but not in memory (a restart puts it back)", 2);
  }
  if (r.status === 401 || r.status === 403) fail(`authentication rejected (HTTP ${r.status})`, 1);
  if (!r.ok) {
    const t = await r.text();
    fail(`failed (HTTP ${r.status}): ${t.slice(0, 200)}`, 2);
  }

  const body = await r.text();

  // The JSON is validated BEFORE writing: a corrupt export on disk is worse
  // than an absent export, because it only shows up at re-import time.
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    fail(`the response is not valid JSON: ${e.message}`, 2);
  }

  // Filename: we trust the server header (the single source of
  // truth for the title-cleaning rule) rather than re-implementing it.
  let name = null;
  const cd = r.headers.get('content-disposition') || '';
  const mm = /filename="([^"]+)"/.exec(cd);
  if (mm) name = mm[1];
  if (!name) name = `${shortId(s.id)}.openfox-session.json`;

  if (explicit === '-') {
    // Redirection to stdout: useful for piping, but we warn on stderr.
    process.stdout.write(body);
    return;
  }
  const out = explicit || path.join(process.cwd(), name);

  try {
    fs.writeFileSync(out, body);
  } catch (e) {
    fail(`cannot write ${out}: ${e.message}`, 2);
  }

  console.log('');
  ok(`written: ${out}`);
  info(`size      : ${fmtBytes(Buffer.byteLength(body))}`);
  if (parsed.format) info(`format    : ${parsed.format} v${parsed.version ?? '?'}`);
  if (parsed.source?.openfoxVersion) info(`source    : OpenFox ${parsed.source.openfoxVersion}`);
  if (Array.isArray(parsed.messages)) info(`messages  : ${parsed.messages.length}`);
  else if (Array.isArray(parsed.session?.messages)) info(`messages  : ${parsed.session.messages.length}`);
  console.log('');
  info(dim('re-importable server-side via POST /api/sessions/import (projectId + payload);'));
  info(dim('ofx does not expose it yet — import writes into a session, not the other way round.'));
  console.log('');
}

// ---------------------------------------------------------------------------
// new / rm — session creation and deletion
// ---------------------------------------------------------------------------
// Projects: read from the database (read-only), because the API requires a projectId
// to create a session or to import one.
function loadProjects() {
  const db = openDb();
  const projects = db.prepare('SELECT id, name, workdir FROM projects ORDER BY name').all();
  db.close();
  if (!projects.length) fail('no project in the database', 1);
  return projects;
}

// Resolves a project by identifier, prefix or name fragment.
// Without an argument: lists the projects and stops (there is no default value).
function resolveProject(projects, arg, hint) {
  if (!arg) {
    console.log('');
    console.log('  ' + C.b + 'Available projects' + C.x + dim('   ' + hint));
    console.log('');
    for (const p of projects) {
      console.log(
        '  ' + shortId(p.id) + '  ' + pad(String(p.name || '').slice(0, 26), 28) + dim(String(p.workdir || '').slice(0, 46))
      );
    }
    console.log('');
    info(dim(`${projects.length} project(s). The server requires a projectId: there is no default value.`));
    console.log('');
    process.exit(1);
  }
  const byId = projects.filter((p) => p.id === arg);
  const matches = byId.length
    ? byId
    : projects.filter((p) => p.id.startsWith(arg) || String(p.name || '').toLowerCase().includes(String(arg).toLowerCase()));
  if (!matches.length) fail(`project not found: ${arg}`, 1);
  if (matches.length > 1) {
    console.log('');
    ko(`"${arg}" is ambiguous, ${matches.length} projects match:`);
    for (const p of matches.slice(0, 10)) info(`${shortId(p.id)}  ${p.name}`);
    console.log('');
    process.exit(1);
  }
  return matches[0];
}

async function cmdNew(argv) {
  const projectArg = optValue(argv, ['--project', '-p']);
  const title = optValue(argv, ['--title', '-t']);

  const token = requireTokenOrExplain(await apiToken());
  const project = resolveProject(loadProjects(), projectArg, 'create with: ofx new --project <id> [--title "..."]');

  console.log('');
  console.log(`  ${C.b}ofx new${C.x}  project ${project.name}  ${dim(project.workdir)}`);
  console.log('');

  let r;
  try {
    r = await apiFetch('/api/sessions', {
      method: 'POST',
      token,
      body: { projectId: project.id, ...(title ? { title } : {}) },
      timeoutMs: 15000,
    });
  } catch (e) {
    fail(`API call failed: ${e.message}`, 2);
  }
  const text = await r.text();
  if (r.status === 404) fail("project unknown to the server (it exists in the database but not in memory): restart the service", 2);
  if (r.status === 400) fail(`request rejected: ${text.slice(0, 200)}`, 2);
  if (!r.ok) fail(`failed (HTTP ${r.status}): ${text.slice(0, 200)}`, 2);

  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  const id = j.session?.id || null;
  ok(id ? `session created: ${id}` : 'session created');
  console.log('');
  if (id) info(dim(`next: ofx inspect ${shortId(id)}`));
  console.log('');
}

async function cmdRm(argv) {
  const selector = selectorOf(argv);
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  if (!selector) fail('usage: ofx rm <id|--hot> [--yes]', 1);

  const db = openDb();
  const rows = sessionMetrics(db);
  const s = resolveSession(rows, selector);
  db.close();

  const token = requireTokenOrExplain(await apiToken());

  console.log('');
  console.log(`  ${C.b}ofx rm${C.x}  ${s.id}`);
  console.log('');
  console.log(`  title    : ${s.title || dim('(untitled)')}`);
  console.log(`  volume   : ${s.n.toLocaleString('en-US')} events / ${fmtBytes(s.bytes)}`);
  console.log(`  workdir  : ${s.workdir || '-'}`);
  console.log('');
  console.log('  ' + C.r + 'PERMANENT deletion: nothing restores it.' + C.x);
  if (s.is_running) warn("the session is running: it will be stopped and its current turn abandoned");
  if (s.bytes > 1024 * 1024) {
    info(dim(`tip: ofx export ${shortId(s.id)}  to archive it first`));
  }
  console.log('');

  if (!assumeYes) {
    if (!process.stdin.isTTY) fail('interactive confirmation required (or --yes)', 1);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise((res) => rl.question('  Delete? (yes/no) ', res));
    rl.close();
    const v = String(a).trim().toLowerCase();
    if (v !== 'oui' && v !== 'o' && v !== 'y' && v !== 'yes') {
      console.log('');
      info("cancelled — nothing has been deleted.");
      console.log('');
      process.exit(0);
    }
    console.log('');
  }

  let r;
  try {
    r = await apiFetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE', token, timeoutMs: 20000 });
  } catch (e) {
    fail(`API call failed: ${e.message}`, 2);
  }
  if (r.status === 404) fail("session unknown to the server (nothing has been deleted)", 2);
  if (!r.ok) {
    const t = await r.text();
    fail(`failed (HTTP ${r.status}): ${t.slice(0, 200)}`, 2);
  }
  ok('session deleted');
  console.log('');
}

// ---------------------------------------------------------------------------
// import — re-import a session export (CREATES a session)
// ---------------------------------------------------------------------------
async function cmdImport(argv) {
  const FLAGS = ['--project', '-p'];
  const file = positionalOf(argv, FLAGS)[0];
  if (!file) fail('usage: ofx import <file.json|-> --project <id|prefix>', 1);
  const projectArg = optValue(argv, FLAGS);

  // --- 1. read -------------------------------------------------------------
  let raw;
  let label = file;
  if (file === '-') {
    label = '(stdin)';
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
      fail(`cannot read stdin: ${e.message}`, 1);
    }
  } else {
    if (!fs.existsSync(file)) fail(`file not found: ${file}`, 1);
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      fail(`unreadable file: ${e.message}`, 1);
    }
    if (!st.isFile()) fail(`not a file: ${file}`, 1);
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      fail(`cannot read: ${e.message}`, 1);
    }
  }
  if (!raw || !raw.trim()) fail('empty file', 1);

  // --- 2. validate BEFORE sending -----------------------------------------
  // The server validates with zod and answers 400 with a raw message. Better to say
  // exactly what is wrong, here, without making the round trip.
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON: ${e.message}`, 1);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail("the JSON is not an object", 1);
  }
  if (payload.format !== EXPORT_FORMAT) {
    fail(`unexpected format: ${JSON.stringify(payload.format)} (expected "${EXPORT_FORMAT}")`, 1);
  }
  if (payload.version !== EXPORT_VERSION) {
    fail(`unsupported export version: ${payload.version} (this installation expects ${EXPORT_VERSION})`, 1);
  }
  if (!Array.isArray(payload.events) || !payload.events.some((e) => e && e.type === 'session.initialized')) {
    fail("invalid export: no 'session.initialized' event (the server rejects it too)", 1);
  }

  // --- 3. size ------------------------------------------------------------
  // express.json limits the body to 75 MB. The body sent is { projectId, payload }:
  // the payload is re-serialized there identically (the file is already the
  // server's JSON.stringify), so the file size is a good measure.
  // This avoids an extra JSON.stringify, which would double the memory used.
  const payloadBytes = Buffer.byteLength(raw);
  const limitBytes = API_BODY_LIMIT_MB * 1024 * 1024;
  if (payloadBytes > limitBytes - IMPORT_MARGIN_BYTES) {
    console.log('');
    ko(`export too large for the API: ${fmtBytes(payloadBytes)}`);
    info(`the server limit is ${API_BODY_LIMIT_MB} MB per request (express.json limit)`);
    info(dim("a large session export therefore cannot be re-imported through the API."));
    info(dim('the file remains valid: keep it, or import it from a future version.'));
    console.log('');
    process.exit(1);
  }

  // --- 4. destination -----------------------------------------------------
  const project = resolveProject(
    loadProjects(),
    projectArg,
    'import with: ofx import <file> --project <id>'
  );
  const token = requireTokenOrExplain(await apiToken());

  console.log('');
  console.log(`  ${C.b}ofx import${C.x}  ${dim(label)}`);
  console.log('');
  info(`format     : ${payload.format} v${payload.version}`);
  info(`size       : ${fmtBytes(payloadBytes)}   (limit ${API_BODY_LIMIT_MB} MB)`);
  info(`source     : ${payload.source?.projectName ?? '?'}  ${dim(String(payload.source?.workdir ?? ''))}`);
  info(`openfox    : ${payload.source?.openfoxVersion ?? '?'}   exported on ${payload.exportedAt ? new Date(payload.exportedAt).toISOString() : '?'}`);
  info(`content    : ${payload.events.length} events, ${Array.isArray(payload.messages) ? payload.messages.length : '?'} messages`);
  info(`destination: ${project.name}  ${dim(project.workdir)}`);
  console.log('');

  // --- 5. send ------------------------------------------------------------
  let r;
  try {
    r = await apiFetch('/api/sessions/import', {
      method: 'POST',
      token,
      body: { projectId: project.id, payload },
      timeoutMs: 300000,
    });
  } catch (e) {
    fail(`API call failed: ${e.message}`, 2);
  }
  const text = await r.text();

  if (r.status === 413) {
    console.log('');
    ko('rejected by the server: request body too large (HTTP 413)');
    info(dim(`the real limit is therefore lower than ${API_BODY_LIMIT_MB} MB on this instance`));
    console.log('');
    process.exit(2);
  }
  if (r.status === 404) {
    fail('project unknown to the server (present in the database but not in memory): restart the service', 2);
  }
  if (r.status === 401 || r.status === 403) fail(`authentication rejected (HTTP ${r.status})`, 1);
  if (r.status !== 201) {
    let msg = text.slice(0, 300);
    try {
      msg = JSON.parse(text).error || msg;
    } catch {
      /* non-JSON response */
    }
    console.log('');
    ko(`import rejected (HTTP ${r.status})`);
    info(String(msg).replace(/\s+/g, ' ').slice(0, 240));
    console.log('');
    info(dim("the API modifies nothing on error: no partial session is created."));
    console.log('');
    process.exit(2);
  }

  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  const id = j.session?.id || null;
  console.log('');
  ok(id ? `session imported: ${id}` : 'session imported');
  if (j.session?.title) info(`title: ${j.session.title}`);
  console.log('');
  info(dim('the title and the model come from the export: the import API does not override them.'));
  if (id) {
    info(dim(`opening in a project different from the original: the working directory is that of the project.`));
    info(dim(`next: ofx inspect ${shortId(id)}`));
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Per-command help
// ---------------------------------------------------------------------------
const ALIASES = { ls: 'list', show: 'inspect' };

const HELP = {
  status: {
    resume: "service + API + database + process state",
    usage: ['ofx status'],
    desc: [
      "READ-ONLY overview. Takes no argument.",
      '',
      'Shows:',
      '  - the systemd service (active/enabled, Restart=, V8 ceiling)',
      '  - the OpenFox processes (pid, RSS)',
      "  - the API (reachable, authentication required or not)",
      '  - the database (size, WAL, processes holding it, running sessions,',
      '    cumulative lag, worst session)',
      '  - sessions flagged RUNNING but probably ghosts',
    ],
    examples: ['ofx status'],
    notes: [
      'Run before any offline operation: indicates who holds the database.',
    ],
  },

  list: {
    resume: 'sessions: volume, snapshots, lag',
    usage: ['ofx list [--all]'],
    desc: [
      'Table of sessions sorted by decreasing lag, RUNNING sessions first.',
      '',
      "By default, only running sessions, or those whose lag exceeds 1 MB, are",
      'shown: on a database of 200+ sessions, the rest is noise.',
      '',
      'Columns:',
      '  SESSION  the first 8 characters of the identifier',
      '  STATE    RUN if the session is flagged as running',
      '  EVENTS   number of events in the session',
      '  DATA     stored payload bytes',
      '  SNAP     number of turn.snapshot (0 in red = none)',
      '  LAG EVTS events accumulated since the last snapshot',
      '  LAG      volume of that lag — what EVERY state load re-reads',
      '  LAST     age of the last event',
    ],
    options: [
      ['--all', 'shows all sessions, including those without notable lag'],
    ],
    examples: ['ofx list', 'ofx list --all'],
    notes: [
      'LAG is the cost metric: 20 MB starts to cost, 100 MB is critical.',
      "A SNAP of 0 means that no snapshot exists: every state load",
      'then falls back to a full scan of the journal.',
    ],
  },

  inspect: {
    resume: "session detail",
    usage: ['ofx inspect <id|--hot> [--fast]'],
    desc: [
      'Analyzes a session in depth: volume, breakdown by event',
      "type, snapshots, hourly growth, and above all the real cost",
      "of a state load.",
    ],
    options: [
      ['--fast', "skips the measurement of the cost of a state load"],
    ],
    examples: [
      'ofx inspect 837d1484',
      'ofx inspect --hot --fast',
    ],
    notes: [
      'The O(n^2) section compares the bytes actually stored for tool.preparing',
      'with what it should be (a single event per tool call). That is the measurement',
      'that explains the journal bloat.',
      'Without --fast, heavy queries are executed: allow ~1 s per',
      '100 MB of lag.',
    ],
  },

  plan: {
    resume: "consolidation impact (dry-run, NEVER writes)",
    usage: ['ofx plan <id|--hot>'],
    desc: [
      'Simulates a consolidation and shows what would happen, without changing anything.',
      '',
      "Four sections:",
      "  1. consolidation eligibility (findOrphanedSessions rules)",
      '  2. consolidation impact: what survives, what disappears',
      '  3. impact of the routine purge (cleanupOldEvents, after each turn)',
      '  4. next steps',
      '',
      'Section 1 distinguishes two kinds of blocker:',
      '  - cleared by a plain restart (is_running = 1)',
      '  - requires human action or waiting (updated_at < 5 min,',
      '    no snapshot)',
    ],
    options: [],
    examples: ['ofx plan --hot', 'ofx plan 837d1484'],
    notes: [
      'Consolidation is NOT replayed by this tool: it is triggered by',
      'the server itself at startup. Plan only verifies the preconditions.',
      'The volume shown is what is removed from the rows: the FILE will only',
      'shrink after a VACUUM (openfox-vacuum.cjs).',
    ],
  },

  watch: {
    resume: 'live journal growth',
    usage: ['ofx watch [--interval N] [--samples N] [--warn MB] [--crit MB]'],
    desc: [
      'Tracks the SPEED of journal growth, not only its size at',
      'time T. This is what allows deciding WHEN to compact before the',
      'phenomenon runs away.',
      '',
      'READ-ONLY. Runs until Ctrl+C (or --samples).',
    ],
    options: [
      ['--interval N', 'seconds between two measurements (default 60)'],
      ['--samples N', 'stops after N measurements'],
      ['--warn MB', 'warning threshold in MB accumulated since the snapshot (default 15)'],
      ['--crit MB', 'critical threshold in MB (default 25)'],
    ],
    examples: [
      'ofx watch',
      'ofx watch --interval 30 --samples 10',
    ],
    notes: [
      'Delegated to openfox-session-watch.cjs (single source).',
      'Exit code: 0 never exceeded, 1 warning threshold, 2 critical threshold.',
    ],
  },

  diagnose: {
    resume: "health report (watchdog thresholds)",
    usage: ['ofx diagnose'],
    desc: [
      "Full check: processes (instantaneous CPU, RSS, V8 ceiling), database",
      '(size, WAL, reclaimable pages), sessions (lag, snapshots), and the',
      'corresponding alerts.',
      '',
      'READ-ONLY: no kill, no write, database opened readonly.',
    ],
    examples: ['ofx diagnose'],
    notes: [
      'Delegated to openfox-watchdog.sh (single source for the thresholds).',
      'Exit code: 0 OK, 1 WARN, 2 CRITICAL.',
      'Thresholds overridable via OPENFOX_WD_* (see openfox-watchdog.sh).',
    ],
  },

  backup: {
    resume: 'coherent backup of the database',
    usage: ['ofx backup [--out DIR] [--keep N]'],
    desc: [
      "Backup via SQLite's online backup API: produces a single coherent",
      "file, even with the server running (a plain cp of a file in WAL",
      'mode would give an incoherent image).',
    ],
    options: [
      ['--out DIR', 'destination directory (default ./backup)'],
      ['--keep N', 'keeps only the N most recent backups'],
    ],
    examples: ['ofx backup', "ofx backup --keep 1"],
    notes: [
      'Delegated to openfox-backup.cjs (single source).',
      'Each backup weighs as much as the database: think about --keep.',
    ],
  },

  vacuum: {
    resume: 'checkpoint WAL + VACUUM (server MUST BE STOPPED)',
    usage: ['ofx vacuum [--dry-run] [--yes]'],
    desc: [
      'Returns the free pages of the file to the system. cleanupOldEvents() frees',
      'pages without shrinking the file: only a VACUUM does that.',
    ],
    options: [
      ['--dry-run', 'checks and BEFORE metrics, modifies nothing'],
      ['--yes', 'do not ask for confirmation'],
    ],
    examples: ['ofx vacuum --dry-run', 'ofx vacuum'],
    notes: [
      'Delegated to openfox-vacuum.cjs (single source).',
      'ABSOLUTE PREREQUISITE: the server must be STOPPED. The script refuses to',
      'run if another process holds the database.',
      "Exit code: 0 success, 1 prerequisites not met, 2 verification failure.",
    ],
  },

  export: {
    resume: 'export a session to a file (modifies nothing)',
    usage: ['ofx export <id|--hot> [-o file]', 'ofx export <id> -o -'],
    desc: [
      "Fetches the complete export of a session via GET /api/sessions/:id/export and",
      "writes it to disk. It is the safety net BEFORE a compaction or a deletion.",
      '',
      "Content: format, version, exportedAt, source (OpenFox version, project, workdir,",
      'mode, effective model) and the session (title, messages, state).',
      '',
      "The default file name comes from the server's Content-Disposition header",
      '(cleaned-up title + .openfox-session.json): ofx does not re-implement that rule.',
      '',
      '-o - writes to stdout, for redirecting or piping.',
    ],
    options: [['-o, --out <file>', 'destination (default: ./<title>.openfox-session.json)']],
    examples: ['ofx export --hot', 'ofx export 837d1484 -o /tmp/s.json', 'ofx export --hot -o - | head -c 200'],
    notes: [
      'TOKEN REQUIRED.',
      "The JSON is validated BEFORE being written: a corrupt export would not",
      "be noticed until re-import.",
      "The server loads all sessions at startup: an old session therefore exports",
      "just as well as a recent one (verified: Session 1, 33 days, 1041 bytes).",
      'A 404 means the server does not know it at all: deleted since, or',
      'database and server out of sync.',
      'ofx NEVER writes into the session: no risk for it.',
      'To re-import it: ofx import <file> --project <id>',
    ],
  },

  import: {
    resume: 're-import a session export (CREATES a session)',
    usage: [
      'ofx import <file.json> --project <id|prefix>',
      'ofx import - --project <id>        (reads from stdin)',
    ],
    desc: [
      'Sends an export to POST /api/sessions/import and creates a NEW session.',
      "The original is not touched and stays where it is.",
      '',
      'The file is validated BEFORE sending (format, version, presence of',
      "session.initialized): the server validates with zod and answers 400 with a raw",
      "message, so better to state right here exactly what is wrong.",
      '',
      "The title and the model come from the export: the import API does not override them.",
      'The session lands in the project you designate, with the workdir',
      'of that project (not the one of the original project).',
    ],
    options: [['-p, --project <id>', 'destination project (mandatory)']],
    examples: [
      'ofx import Session_58.openfox-session.json --project addax-agents',
      'ofx export --hot -o - | ofx import - --project addax-agents',
    ],
    notes: [
      'TOKEN REQUIRED.',
      'LIMIT OF 75 MB: app.use(express.json({ limit: "75mb" })) on the server side',
      '(chunk-2J6OW67H.js:8608). Beyond that, the server refuses the body (HTTP 413). ofx',
      'checks the file size BEFORE sending and refuses with a clear message.',
      'IMPORTANT: a large exported session may therefore be impossible to',
      're-import. Check the size of your exports before relying on them.',
      "On error, the API creates nothing: no partial session.",
      'The provider is resolved by identifier, otherwise by (backend + url + model);',
      "if it matches nothing, the import happens without a provider.",
    ],
  },

  new: {
    resume: 'create a session',
    usage: ['ofx new --project <id|prefix> [--title "..."]', 'ofx new'],
    desc: [
      'Creates a session in a project via POST /api/sessions.',
      "Without --project, it lists the projects and stops: the API requires a",
      "projectId and has no default value.",
    ],
    options: [
      ['-p, --project <id>', 'destination project (identifier or prefix)'],
      ['-t, --title <title>', 'session title (optional)'],
    ],
    examples: ['ofx new', 'ofx new --project addax-agents --title "audit"'],
    notes: [
      'TOKEN REQUIRED.',
      'The project must be loaded in memory by the server, otherwise 404.',
      'The model used is the one from the server defaultModelSelection setting.',
    ],
  },

  rm: {
    resume: 'delete a session (PERMANENT)',
    usage: ['ofx rm <id|--hot> [--yes]'],
    desc: [
      'Deletes the session via DELETE /api/sessions/:id.',
      'If it is running, its current turn is abandoned before the deletion.',
    ],
    options: [['--yes, -y', 'do not ask for confirmation']],
    examples: ['ofx rm 28d72f70', 'ofx rm --hot'],
    notes: [
      'TOKEN REQUIRED.',
      'INTERACTIVE CONFIRMATION by default: the deletion is permanent.',
      'ofx reminds you to make an export if the session exceeds 1 MB.',
      "Without --yes and without a terminal, the command refuses to continue.",
    ],
  },

  auth: {
    resume: 'manage credentials (masked input, 600 storage)',
    usage: [
      'ofx auth login        ask for the password, obtain and store a token',
      'ofx auth set-token    paste an existing token',
      'ofx auth status       where ofx finds its credentials, and with what rights',
      'ofx auth check        verify that the credentials are accepted',
      'ofx auth clear        delete the stored token',
    ],
    desc: [
      "Avoid exporting OPENFOX_TOKEN or OPENFOX_PASSWORD on every command.",
      '',
      "auth login asks for the password WITHOUT echo (shows '*'), outside the shell's",
      "history, exchanges it for a token via the API, VERIFIES that the token works,",
      'then writes it to a file with mode 600. ofx never stores the password.',
      '',
      "auth set-token does the same from a token you paste: useful if",
      'you already have the token, or if you must retrieve it another way.',
      '',
      'WHY A TOKEN RATHER THAN THE PASSWORD: the token is an RSA signature',
      'base64(RSA-SHA256(auth.key, sha256hex(password))). It is not reversible.',
      'The password itself is RECOVERABLE on disk: auth.json contains an',
      'encrypted version that auth.key decrypts. Storing the token is therefore safer.',
      '',
      'The token is DETERMINISTIC and NEVER EXPIRES: it only changes if the',
      'password changes, or if auth.key is regenerated.',
    ],
    options: [
      ['--no-verify', 'set-token: store without testing the token against the API'],
    ],
    examples: ['ofx auth login', 'ofx auth status', 'ofx auth check', 'ofx auth clear'],
    notes: [
      `file: ${OFX_TOKEN_FILE}`,
      'Priority: OPENFOX_TOKEN > this file > OPENFOX_PASSWORD.',
      'Masked input requires a terminal: these commands are not scriptable',
      '(this is deliberate: a secret must not go through a pipe).',
      'Read commands require no credentials at all.',
    ],
  },

  service: {
    resume: 'systemd service lifecycle (absorbed from openfox-ctl)',
    usage: [
      'ofx service start',
      'ofx service stop',
      'ofx service restart',
      'ofx service status [--no-update-check]',
      'ofx service install [version]',
      'ofx service upgrade',
      'ofx logs [N] [-f]',
    ],
    desc: [
      "Drives the systemd unit 'openfox'. These commands come from openfox-ctl,",
      "a hand-written script (it is NOT shipped by OpenFox) that was absorbed",
      "here so that there is only one tool.",
      '',
      'start / stop / restart    sudo systemctl …',
      'status                    installation, service, process, journal, update',
      'install [version]         DESTRUCTIVE: rm -rf /opt/openfox then npm install',
      'upgrade                   DESTRUCTIVE: stop, rm -rf, npm install, start',
      '',
      'restart does stop + 1 s pause + start: this delay releases port 10369 and avoids',
      'the EADDRINUSE documented in the original script history.',
      '',
      'WARNING: "ofx stop" stops a SESSION; "ofx service stop" stops the',
      'SERVICE. The presence of "service" distinguishes the two unambiguously.',
    ],
    options: [
      ['--no-update-check', 'status: do not query api.github.com'],
    ],
    examples: ['ofx service status', 'ofx service restart', 'ofx logs 50', 'ofx logs -f'],
    notes: [
      'MANDATORY CONFIRMATION for install and upgrade: they run a',
      'sudo rm -rf on /opt/openfox. No option allows bypassing it, and',
      "they refuse to run if stdin is not a terminal.",
      "install refuses to run if the service is active (use upgrade, which",
      'handles the stop and restart itself).',
      'All these commands require sudo, except status and logs.',
    ],
  },

  logs: {
    resume: 'service journal (journalctl, falls back to the file)',
    usage: ['ofx logs [N] [-f]'],
    desc: [
      'Shows the last N lines of the journal (default 20).',
      '-f follows the journal live (Ctrl+C to stop).',
      '',
      'Uses journalctl -u openfox. If the journal is unavailable, falls back to the',
      'file ~/.openfox/openfox.log.',
    ],
    options: [
      ['N', 'number of lines (default 20)'],
      ['-f, --follow', 'follow the journal live'],
    ],
    examples: ['ofx logs', 'ofx logs 100', 'ofx logs -f'],
    notes: ['Does not require sudo: this unit journal is readable by your user.'],
  },

  stop: {
    resume: 'stop the current session',
    usage: ['ofx stop <id|--hot>'],
    desc: [
      "Stops the current turn via the server API.",
      "Also discards pending questions and path confirmations, and empties",
      'the message queue.',
    ],
    examples: ['ofx stop --hot', 'ofx stop 837d1484'],
    notes: [
      "TOKEN REQUIRED: the API requires authentication (OPENFOX_TOKEN or",
      'OPENFOX_PASSWORD). See ofx help authentification.',
      'Goes through the server rather than SQLite: its snapshot/prompts caches',
      'stay coherent. A direct write would leave them stale.',
    ],
  },

  pause: {
    resume: 'pause the session',
    usage: ['ofx pause <id|--hot>'],
    desc: ['Pauses a RUNNING session. Fails if the session is not running.'],
    examples: ['ofx pause --hot'],
    notes: ['TOKEN REQUIRED. Delegated to POST /api/sessions/:id/pause.'],
  },

  resume: {
    resume: 'resume a paused session',
    usage: ['ofx resume <id|--hot>'],
    desc: ['Resumes a session previously paused.'],
    examples: ['ofx resume --hot'],
    notes: ['TOKEN REQUIRED. Delegated to POST /api/sessions/:id/resume.'],
  },

  continue: {
    resume: 'restart the session turn',
    usage: ['ofx continue <id|--hot>'],
    desc: ['Restarts a turn where it had stopped.'],
    examples: ['ofx continue --hot'],
    notes: ['TOKEN REQUIRED. Delegated to POST /api/sessions/:id/continue.'],
  },

  compact: {
    resume: 'compact a session (orchestrator, does NOT replay the fold)',
    usage: [
      'ofx compact <id|--hot>                     plan, no modification',
      'ofx compact <id|--hot> --apply             backup + session stop',
      'ofx compact <id|--hot> --apply --restart   + service restart',
    ],
    desc: [
      'Without --apply, behaves exactly like plan: dry-run, nothing is modified.',
      '',
      'With --apply, chains:',
      '  0. pre-checks: eligibility, then token if the session is running',
      '  1. database backup (MANDATORY — abort if it fails)',
      "  2. clean stop of the session via the API",
      '  3. service restart (if --restart): the server consolidates by itself',
      '     at startup — equivalent to ofx service restart',
      '  4. verification: compares the before/after counters, up to 90 s',
      '',
      'What this command does NOT do:',
      '  - replay the fold (EventStore.consolidateSession is server-internal;',
      '    re-implementing it would risk corrupting the session)',
      '  - delete rows directly',
      '  - touch the sequence numbers',
      '  - write to the database while the server is running',
    ],
    options: [
      ['--apply', 'actually execute (without it: dry-run)'],
      ['--restart', 'restarts the service after backup and stop'],
      ['--yes', 'do not ask for confirmation'],
    ],
    examples: [
      'ofx compact --hot',
      "OPENFOX_PASSWORD='...' ofx compact --hot --apply --restart",
    ],
    notes: [
      "The pre-checks run BEFORE the backup: no point writing",
      '700 MB if the consolidation is impossible anyway.',
      'The restart ENDS the current turn: that is the only real loss.',
      'After consolidation, the file will only shrink after a VACUUM.',
      'The restart does stop + 1 s pause + start: the delay releases the port',
      'and avoids the EADDRINUSE documented in the original script history.',
    ],
  },

  help: {
    resume: "display help",
    usage: ['ofx help [command]', 'ofx <command> --help'],
    desc: [
      "Without arguments, shows the command index.",
      'With a command name, shows its detailed help.',
    ],
    examples: ['ofx help', 'ofx help compact', 'ofx compact --help'],
  },

  authentification: {
    resume: 'how the token works (mechanism)',
    usage: ['ofx auth login', 'ofx auth status'],
    desc: [
      'FULL CHAIN:',
      '  installation : an RSA 2048 key pair is generated in ~/.config/openfox/auth.key,',
      '                 and the password is encrypted there (RSA-OAEP) in auth.json.',
      '  login        : POST /api/auth/login {password} -> the server decrypts, compares,',
      '                 then signs sha256hex(password) with the private key.',
      '  header       : x-session-token: <token>   (or Authorization: Bearer <token>)',
      '',
      'THREE PRACTICAL CONSEQUENCES:',
      '  1. the token is deterministic: same password = same token;',
      '  2. it does not expire: no TTL, no revocation, it is computed once;',
      '  3. it is safer to store than the password (non-reversible signature).',
      '',
      'The ofx auth command does all of this for you. See also: ofx help auth.',
    ],
    examples: ['ofx auth login', 'ofx auth check', 'ofx help auth'],
    notes: [
      'OPENFOX_PASSWORD only adds a round trip to /api/auth/login to',
      'recompute the same token: it is a convenience, not a level of security',
      'of its own. The only real difference is what you accept to store.',
    ],
  },

  selecteurs: {
    resume: 'how to designate a session',
    usage: ['ofx <command> <id>', 'ofx <command> --hot'],
    desc: [
      '<id>    full identifier, or unambiguous prefix',
      '        (the first 8 characters are usually enough)',
      '--hot   the session with the largest lag',
    ],
    examples: ['ofx inspect 837d1484', 'ofx inspect --hot'],
    notes: [
      'An ambiguous prefix is refused, and the candidate sessions are listed.',
    ],
  },
};

function canonical(cmd) {
  if (!cmd) return null;
  const c = ALIASES[cmd] || cmd;
  return Object.prototype.hasOwnProperty.call(HELP, c) ? c : null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// Suggest close commands when the input is mistyped.
function suggest(cmd) {
  return Object.keys(HELP)
    .map((k) => [k, levenshtein(cmd, k)])
    .filter(([, dist]) => dist <= 2)
    .sort((x, y) => x[1] - y[1])
    .slice(0, 3)
    .map(([k]) => k);
}

// Detailed help for a command.
function printHelp(name) {
  const h = HELP[name];
  if (!h) return usage();
  console.log('');
  console.log(`  ${C.b}ofx ${name}${C.x} — ${h.resume}`);
  console.log('');
  console.log('  ' + C.b + 'USAGE' + C.x);
  for (const u of h.usage) console.log('    ' + u);
  if (h.desc && h.desc.length) {
    console.log('');
    console.log('  ' + C.b + 'DESCRIPTION' + C.x);
    for (const l of h.desc) console.log('    ' + l);
  }
  if (h.options && h.options.length) {
    console.log('');
    console.log('  ' + C.b + 'OPTIONS' + C.x);
    // Computed width: pad() truncates beyond n, so an option longer
    // than the column would be cut and glued to its description.
    const w = Math.max(...h.options.map(([f]) => f.length)) + 3;
    for (const [f, d] of h.options) {
      console.log('    ' + f + ' '.repeat(Math.max(1, w - f.length)) + d);
    }
  }
  if (h.examples && h.examples.length) {
    console.log('');
    console.log('  ' + C.b + 'EXAMPLES' + C.x);
    for (const e of h.examples) console.log('    ' + e);
  }
  if (h.notes && h.notes.length) {
    console.log('');
    console.log('  ' + C.b + 'NOTES' + C.x);
    for (const n of h.notes) console.log('    ' + n);
  }
  console.log('');
  console.log('  ' + C.d + 'command index: ofx help' + C.x);
  console.log('');
}

function usage() {
  console.log(`
  ${C.b}ofx${C.x} — OpenFox command console

  ${C.d}READ ONLY (no token, no writes)${C.x}
    status                     service + API + database + process state
    list [--all]               sessions: volume, snapshots, lag
    inspect <id|--hot> [--fast]  session detail
    plan <id|--hot>            consolidation impact (dry-run)
    watch [--interval N]       live growth                ${C.d}(delegated)${C.x}
    diagnose                   health report              ${C.d}(delegated)${C.x}
    backup [--out DIR]         coherent backup            ${C.d}(delegated)${C.x}
    vacuum [--dry-run]         offline VACUUM             ${C.d}(delegated)${C.x}

  ${C.d}AUTHENTICATION (tier 2 — required for actions)${C.x}
    auth login                 ask for the password (masked) -> token stored
    auth set-token             paste an existing token
    auth status | check | clear
    (without storing anything: OPENFOX_TOKEN=<token> or OPENFOX_PASSWORD=<password>)
    (read commands need no credentials)

  ${C.d}SERVICE (lifecycle — sudo)${C.x}
    service start|stop|restart|status   control the systemd service
    service install [version]           ${C.r}DESTRUCTIVE${C.x} — mandatory confirmation
    service upgrade                     ${C.r}DESTRUCTIVE${C.x} — mandatory confirmation
    logs [N] [-f]               service journal

  ${C.d}ACTIONS (tier 2, via the API — token required)${C.x}
    stop <id>                  stop the running session
    pause <id> / resume <id>   pause / resume
    continue <id>              restart the turn
    export <id> [-o file]      export a session (modifies nothing)
    import <file> --project <id>      re-import an export (CREATES a session)
    new --project <id>         create a session
    rm <id>                    delete a session (PERMANENT)

  ${C.d}COMPACTION (tier 3, offline)${C.x}
    compact <id|--hot>                    plan only, no modification
    compact <id|--hot> --apply            backup + session stop
    compact <id|--hot> --apply --restart  + service restart
    (--yes to skip the confirmation prompt)

  ${C.d}HELP${C.x}
    help                       this index
    help <command>             detailed help for a command
    <command> --help           same
    help selecteurs             how to designate a session
    help authentification       how the token works (mechanism)

  ${C.d}SELECTORS${C.x}
    <id>        full identifier or unambiguous prefix (8 characters are enough)
    --hot       the session with the largest lag

  ${C.d}EXIT CODES${C.x}  0 success | 1 usage/precondition | 2 failure

  ${C.d}DELIBERATELY NOT EXPOSED${C.x}
    POST /api/sessions/:id/truncate — cuts the conversation destructively
    (deleteEventsAfterSeq). It is not a compaction: do it from the UI.
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const [cmd, ...argv] = process.argv.slice(2);

  if (!cmd) return usage();

  const wantsHelp = argv.includes('--help') || argv.includes('-h');

  // ofx help [command]
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = argv.find((a) => !a.startsWith('-'));
    if (!target) return usage();
    const topic = canonical(target);
    if (!topic) {
      console.log('');
      ko(`help unavailable: unknown command "${target}"`);
      const near = suggest(target);
      if (near.length) info(`did you mean: ${near.join(', ')}`);
      console.log('');
      usage();
      process.exit(1);
    }
    return printHelp(topic);
  }

  const c = canonical(cmd);

  // ofx <command> --help
  if (c && wantsHelp) return printHelp(c);

  switch (c) {
    case 'status':
      return cmdStatus();
    case 'list':
      return cmdList(argv);
    case 'inspect':
      return cmdInspect(argv);
    case 'plan':
      return cmdPlan(argv);
    case 'watch':
      return runSibling('openfox-session-watch.cjs', argv);
    case 'diagnose':
      return runSibling('openfox-watchdog.sh', argv);
    case 'backup':
      return runSibling('openfox-backup.cjs', argv);
    case 'vacuum':
      return runSibling('openfox-vacuum.cjs', argv);
    case 'service':
      return cmdService(argv);
    case 'logs':
      return cmdLogs(argv);
    case 'auth':
      return cmdAuth(argv);
    case 'export':
      return cmdExport(argv);
    case 'import':
      return cmdImport(argv);
    case 'new':
      return cmdNew(argv);
    case 'rm':
      return cmdRm(argv);
    case 'stop':
    case 'pause':
    case 'resume':
    case 'continue':
      return cmdApiAction(c, argv);
    case 'compact':
      return cmdCompact(argv);
    default: {
      // Help topics with no associated command (help, selecteurs, authentification).
      if (c) return printHelp(c);
      console.log('');
      ko(`unknown command: ${cmd}`);
      const near = suggest(cmd);
      if (near.length) info(`did you mean: ${near.join(', ')}`);
      else info('ofx help   for the command index');
      console.log('');
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.log('');
  ko(`unexpected error: ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});