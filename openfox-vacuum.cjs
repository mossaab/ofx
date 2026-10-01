#!/usr/bin/env node
// openfox-vacuum.cjs — compacts OpenFox's sessions.db (WAL checkpoint + VACUUM) and verifies
// integrity and the absence of data loss.
//
// WHY: cleanupOldEvents() frees pages but does not shrink the file. After
// the 25-26/09 incident: a 1327 MB file for 216 MB of real data, i.e.
// ~1.1 GB of free pages that only a VACUUM returns to the system.
//
// ABSOLUTE PREREQUISITE: the OpenFox server must be STOPPED. This script refuses to run
// while any other process holds the database. To stop it:
//   kill -TERM 11690 11699
//
// USAGE
//   node openfox-vacuum.cjs --dry-run    checks + BEFORE metrics, modifies nothing
//   node openfox-vacuum.cjs              WAL checkpoint + VACUUM + verification (confirmation requested)
//   node openfox-vacuum.cjs --yes        same, without confirmation
//
// EXIT CODES
//   0 = success (or conclusive dry-run)
//   1 = prerequisites not met (server running, database missing, not enough space)
//   2 = verification failure after VACUUM (differing counters or broken integrity)
//
// SAFETY: SQLite runs VACUUM in a temporary file then substitutes it atomically.
// On failure, the original database stays intact. No data is created, modified or
// deleted: only free pages are reclaimed.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SQLITE_MODULE =
  process.env.OPENFOX_WD_SQLITE || '/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3';
const DB_PATH =
  process.env.OPENFOX_DB_PATH || path.join(process.env.HOME || '/home/mossaab', '.local/share/openfox/sessions.db');

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const ASSUME_YES = ARGS.has('--yes');

const mb = (n) => (n / 1048576).toFixed(1);
const ok = (s) => console.log('  \u2713 ' + s);
const ko = (s) => console.log('  \u2717 ' + s);
const info = (s) => console.log('    ' + s);

function fail(msg) {
  console.log('');
  ko(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Find the processes holding the database (without relying on lsof)
// ---------------------------------------------------------------------------
function findHolders(dbPath) {
  let real;
  try {
    real = fs.realpathSync(dbPath);
  } catch {
    return [];
  }
  const targets = new Set([real, real + '-wal', real + '-shm']);
  const holders = [];
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
      fds = fs.readdirSync('/proc/' + pid + '/fd');
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync('/proc/' + pid + '/fd/' + fd);
      } catch {
        continue;
      }
      if (targets.has(target)) {
        let cmd = '?';
        try {
          cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').trim().slice(0, 100);
        } catch {}
        holders.push({ pid, cmd });
        break;
      }
    }
  }
  return holders;
}

// ---------------------------------------------------------------------------
// Metrics of a database (read-only)
// ---------------------------------------------------------------------------
function readMetrics(Database) {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('query_only = true');
  const m = {};
  m.integrity = db.pragma('integrity_check', { simple: true });
  m.journalMode = db.pragma('journal_mode', { simple: true });
  m.autoVacuum = db.pragma('auto_vacuum', { simple: true });
  const ps = db.pragma('page_size', { simple: true });
  const pc = db.pragma('page_count', { simple: true });
  const fl = db.pragma('freelist_count', { simple: true });
  m.pageSize = ps;
  m.pageCount = pc;
  m.freelistCount = fl;
  m.liveBytes = (pc - fl) * ps;
  m.freeBytes = fl * ps;
  m.events = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  m.sessions = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  m.running = db.prepare('SELECT COUNT(*) n FROM sessions WHERE is_running = 1').get().n;
  const top = db
    .prepare('SELECT session_id, COUNT(*) n, SUM(LENGTH(payload)) b FROM events GROUP BY session_id ORDER BY b DESC LIMIT 1')
    .get();
  m.topSessionId = top ? top.session_id : '-';
  m.topSessionEvents = top ? top.n : 0;
  m.topSessionMB = top && top.b ? mb(top.b) : '0';
  try {
    const jm = db.pragma('journal_mode');
    if (Array.isArray(jm)) m.journalMode = jm[0].journal_mode ?? m.journalMode;
  } catch {}
  db.close();
  return m;
}

function printMetrics(title, m, fileSize) {
  console.log('');
  console.log(title);
  info(`file             : ${mb(fileSize)} MB`);
  info(`pages            : ${m.pageCount} (size ${m.pageSize} B) — of which ${m.freelistCount} free`);
  info(`live data        : ${mb(m.liveBytes)} MB`);
  info(`reclaimable space: ${mb(m.freeBytes)} MB`);
  info(`events / sessions: ${m.events} / ${m.sessions} (running: ${m.running})`);
  info(`biggest session  : ${m.topSessionEvents} events / ${m.topSessionMB} MB (${m.topSessionId})`);
  info(`integrity        : ${m.integrity}`);
  info(`journal / autovac: ${m.journalMode} / ${m.autoVacuum}`);
}

// ---------------------------------------------------------------------------
// Main program
// ---------------------------------------------------------------------------
console.log('=== openfox-vacuum ===' + (DRY_RUN ? '  [DRY-RUN MODE — no modification]' : ''));
console.log('  database: ' + DB_PATH);

if (!fs.existsSync(DB_PATH)) fail('Database not found: ' + DB_PATH);

let Database;
try {
  Database = require(SQLITE_MODULE);
} catch (e) {
  fail('better-sqlite3 not found (' + SQLITE_MODULE + '): ' + e.message);
}

// --- 1. prerequisites: no one must hold the database ---
console.log('');
console.log('1. Prerequisite checks');
const holders = findHolders(DB_PATH);
if (holders.length > 0) {
  ko(`The OpenFox server is still running: ${holders.length} process(es) hold the database.`);
  for (const h of holders) info(`pid ${h.pid}: ${h.cmd}`);
  console.log('');
  info('Stop it first:  kill -TERM 11690 11699');
  info('VACUUM requires an exclusive lock: any other connection will make it fail.');
  process.exit(1);
}
ok('No other process holds the database');

const fileSizeBefore = fs.statSync(DB_PATH).size;
let walSizeBefore = 0;
try {
  walSizeBefore = fs.statSync(DB_PATH + '-wal').size;
} catch {}
info(`file ${mb(fileSizeBefore)} MB | wal ${mb(walSizeBefore)} MB`);

// --- 2. integrity and BEFORE metrics ---
console.log('');
console.log('2. Reading the BEFORE state');
let before;
try {
  before = readMetrics(Database);
} catch (e) {
  fail('Cannot read: ' + e.message);
}
printMetrics('   --- BEFORE state ---', before, fileSizeBefore);

if (before.integrity !== 'ok') {
  console.log('');
  ko('integrity_check != ok: DO NOT run a VACUUM on a suspect database.');
  info('Restore a backup before any operation (see PROCEDURE-MAINTENANCE-OPENFOX.md).');
  process.exit(1);
}
ok('Database integrity: ok');

// --- 3. disk space ---
console.log('');
console.log('3. Disk space');
const needed = before.liveBytes * 2.5 + 64 * 1048576;
let free = 0;
try {
  const st = fs.statfsSync(path.dirname(DB_PATH));
  free = st.bsize * st.bavail;
} catch (e) {
  info('statfs unavailable, check skipped');
}
if (free > 0) {
  info(`estimated need ~${mb(needed)} MB | available ${mb(free)} MB`);
  if (free < needed) fail('Not enough space to rebuild the database.');
  ok('Enough space');
}

if (DRY_RUN) {
  console.log('');
  console.log('=== DRY-RUN finished: nothing was modified ===');
  info(`A VACUUM would free up ~${mb(before.freeBytes)} MB.`);
  process.exit(0);
}

if (before.freelistCount === 0) {
  console.log('');
  console.log('Nothing to do: no free pages (freelist = 0).');
  process.exit(0);
}

// --- 4. confirmation ---
async function confirm() {
  if (ASSUME_YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`\nRebuild the database (VACUUM, ~${mb(before.freeBytes)} MB freed)? [y/N] `, res)
  );
  rl.close();
  return /^(o|oui|y|yes)$/i.test(answer.trim());
}

(async () => {
  if (!(await confirm())) {
    console.log('Cancelled. Nothing was modified.');
    process.exit(0);
  }

  // --- 5. WAL checkpoint ---
  console.log('');
  console.log('4. WAL checkpoint');
  let db;
  try {
    db = new Database(DB_PATH);
  } catch (e) {
    fail('Cannot open for writing: ' + e.message);
  }
  try {
    const ck = db.pragma('wal_checkpoint(TRUNCATE)');
    info('wal_checkpoint(TRUNCATE): ' + JSON.stringify(ck));
    ok('WAL checkpointed into the main file');
  } catch (e) {
    info('checkpoint: ' + e.message + ' (non blocking)');
  }

  // --- 6. VACUUM ---
  console.log('');
  console.log('5. VACUUM');
  const t0 = Date.now();
  try {
    db.exec('VACUUM');
  } catch (e) {
    db.close();
    console.log('');
    ko('VACUUM FAILED: ' + e.message);
    info('SQLite rebuilds into a temporary file then substitutes it: the original');
    info('database is intact. Check disk space and re-run.');
    process.exit(1);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  ok(`VACUUM completed in ${elapsed} s`);
  try {
    const jm = db.pragma('journal_mode', { simple: true });
    info('journal_mode after VACUUM: ' + jm);
  } catch {}
  db.close();

  // --- 7. AFTER verification ---
  console.log('');
  console.log('6. AFTER verification');
  const fileSizeAfter = fs.statSync(DB_PATH).size;
  let walSizeAfter = 0;
  try {
    walSizeAfter = fs.statSync(DB_PATH + '-wal').size;
  } catch {}
  let after;
  try {
    after = readMetrics(Database);
  } catch (e) {
    fail('Cannot re-read: ' + e.message);
  }
  printMetrics('   --- AFTER state ---', after, fileSizeAfter);

  console.log('');
  console.log('7. Non-regression checks');
  let failed = false;
  const check = (label, condition, detail) => {
    if (condition) ok(`${label}: ${detail}`);
    else {
      ko(`${label}: ${detail}`);
      failed = true;
    }
  };
  check('integrity', after.integrity === 'ok', after.integrity);
  check('events', after.events === before.events, `${before.events} -> ${after.events}`);
  check('sessions', after.sessions === before.sessions, `${before.sessions} -> ${after.sessions}`);
  check('running sessions', after.running === before.running, `${before.running} -> ${after.running}`);
  check(
    'biggest session',
    after.topSessionEvents === before.topSessionEvents,
    `${before.topSessionEvents} -> ${after.topSessionEvents} events (${after.topSessionId})`
  );

  console.log('');
  console.log('8. Summary');
  info(`file: ${mb(fileSizeBefore)} MB -> ${mb(fileSizeAfter)} MB`);
  info(`free pages: ${before.freelistCount} -> ${after.freelistCount}`);
  info(`live data: ${mb(before.liveBytes)} MB -> ${mb(after.liveBytes)} MB`);
  info(`space returned to the system: ~${mb(fileSizeBefore - fileSizeAfter)} MB`);
  info(`wal: ${mb(walSizeBefore)} MB -> ${mb(walSizeAfter)} MB`);

  console.log('');
  if (failed) {
    ko('CHECKS FAILED — restore the backup before restarting OpenFox.');
    process.exit(2);
  }
  ok('VACUUM successful: no data lost.');
  console.log('');
  console.log('Then restart OpenFox:');
  console.log('  sudo systemctl start openfox.service     (if the systemd service is installed)');
  console.log('  or: nohup /home/mossaab/.local/share/pi-node/node-v22.22.3-linux-x64/bin/node \\');
  console.log('       /opt/openfox/bin/openfox --port 10369 --no-browser >/dev/null 2>&1 &');
  process.exit(0);
})();
