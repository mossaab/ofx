#!/usr/bin/env node
// openfox-session-watch.cjs — LIVE monitoring of the current OpenFox session.
//
// Goal: see the GROWTH SPEED of the journal, not just its size at time T.
// This is what allows deciding WHEN to compact before the phenomenon runs away.
//
// READ-ONLY: database opened readonly + query_only, /proc for CPU. Nothing is modified.
//
// USAGE
//   node openfox-session-watch.cjs                  # one line every 60 s, until Ctrl+C
//   node openfox-session-watch.cjs --interval 30    # every 30 s
//   node openfox-session-watch.cjs --samples 10     # stops after 10 measurements (for a log)
//   node openfox-session-watch.cjs --warn 12 --crit 20
//
// EXIT CODES: 0 = never exceeded, 1 = warning threshold reached, 2 = critical threshold reached

const fs = require('fs');
const path = require('path');

const SQLITE_MODULE =
  process.env.OPENFOX_WD_SQLITE || '/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3';
const DB_PATH =
  process.env.OPENFOX_DB_PATH || path.join(process.env.HOME || '/home/mossaab', '.local/share/openfox/sessions.db');

const argv = process.argv.slice(2);
const opt = { interval: 60, samples: 0, warn: 15, crit: 25 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--interval') opt.interval = Number(argv[++i]);
  else if (argv[i] === '--samples') opt.samples = Number(argv[++i]);
  else if (argv[i] === '--warn') opt.warn = Number(argv[++i]);
  else if (argv[i] === '--crit') opt.crit = Number(argv[++i]);
}

const Database = require(SQLITE_MODULE);
const W = (s, n) => String(s).padEnd(n);
const P = (s, n) => String(s).padStart(n);

const readCpu = () => {
  // instant of the server's CPU time: delta of jiffies between two measurements
  const tryPid = () => {
    try {
      for (const p of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(p)) continue;
        try {
          const cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8');
          if (cmd.includes('openfox')) {
            const st = fs.readFileSync('/proc/' + p + '/stat', 'utf8');
            const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
            return { pid: Number(p), ticks: Number(f[11]) + Number(f[12]) };
          }
        } catch {}
      }
    } catch {}
    return null;
  };
  return tryPid();
};

function sample() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('query_only = true');

  const running = db
    .prepare('SELECT id, title, is_running FROM sessions WHERE is_running = 1 ORDER BY updated_at DESC LIMIT 1')
    .get();
  // Target session: the RUNNING one if it exists. Otherwise the most recently updated
  // (and not the largest: an old dormant session with a big snapshot has no value to watch).
  const focus =
    running || db.prepare('SELECT id, title, is_running FROM sessions ORDER BY updated_at DESC LIMIT 1').get();

  if (!focus) {
    db.close();
    return null;
  }

  const ev = db
    .prepare('SELECT COUNT(*) n, SUM(LENGTH(payload)) b FROM events WHERE session_id = ?')
    .get(focus.id);
  const snap = db
    .prepare("SELECT COUNT(*) n, MAX(seq) mx FROM events WHERE session_id = ? AND event_type = 'turn.snapshot'")
    .get(focus.id);
  const mx = db.prepare('SELECT MAX(seq) mx FROM events WHERE session_id = ?').get(focus.id);
  const snapSeq = snap && snap.mx ? snap.mx : 0;
  const lag = db
    .prepare('SELECT COUNT(*) n, SUM(LENGTH(payload)) b FROM events WHERE session_id = ? AND seq > ?')
    .get(focus.id, snapSeq);

  db.close();
  return {
    id: focus.id,
    title: focus.title,
    running: !!focus.is_running,
    events: ev.n || 0,
    totalMB: (ev.b || 0) / 1048576,
    lagEvents: lag.n || 0,
    lagMB: (lag.b || 0) / 1048576,
    snapshots: snap.n || 0,
    lastSeq: mx && mx.mx ? mx.mx : 0,
  };
}

const hhmmss = (d) =>
  String(d.getHours()).padStart(2, '0') +
  ':' +
  String(d.getMinutes()).padStart(2, '0') +
  ':' +
  String(d.getSeconds()).padStart(2, '0');

let prev = null;
let prevCpu = readCpu();
let worst = 0;
let n = 0;

console.log('=== openfox-session-watch ===  (Ctrl+C to stop)');
console.log(`  thresholds: warning ${opt.warn} MB | critical ${opt.crit} MB   |   interval ${opt.interval} s`);
console.log('');
console.log(
  '  ' +
    W('time', 9) +
    P('events', 9) +
    P('total', 10) +
    P('LAG', 10) +
    P('snap', 5) +
    P('speed', 14) +
    P('min to crit', 12) +
    P('cpu', 6) +
    '  state'
);
console.log('  ' + '-'.repeat(84));

async function loop() {
  for (;;) {
    const s = sample();
    const cpu = readCpu();
    const now = new Date();

    let cpuPct = '-';
    if (cpu && prevCpu && cpu.pid === prevCpu.pid) {
      const dt = opt.interval;
      cpuPct = Math.round(((cpu.ticks - prevCpu.ticks) / 100 / dt) * 100) + '%';
    }

    if (!s) {
      console.log(`  ${hhmmss(now)}  no session found`);
    } else {
      let speed = '-';
      let eta = '-';
      if (prev && s.lagMB > prev.lagMB && prev.t && prev.t !== now) {
        const dtMin = (now - prev.t) / 60000;
        const rate = (s.lagMB - prev.lagMB) / dtMin; // MB per minute
        speed = rate.toFixed(2) + ' MB/min';
        if (rate > 0.0001) {
          const reste = (opt.crit - s.lagMB) / rate;
          eta = reste > 0 ? Math.round(reste) + ' min' : 'exceeded';
        }
      }

      let etat = 'ok';
      if (s.lagMB >= opt.crit) {
        etat = '>>> CRITICAL — COMPACT <<<';
        worst = 2;
      } else if (s.lagMB >= opt.warn) {
        etat = '>>> warning — plan a compaction <<<';
        if (worst < 1) worst = 1;
      } else if (!s.running) {
        etat = 'session stopped (turn done)';
      }

      console.log(
        '  ' +
          W(hhmmss(now), 9) +
          P(s.events, 9) +
          P(s.totalMB.toFixed(2) + ' MB', 10) +
          P(s.lagMB.toFixed(2) + ' MB', 10) +
          P(s.snapshots, 5) +
          P(speed, 14) +
          P(eta, 12) +
          P(cpuPct, 6) +
          '  ' +
          etat
      );

      if (n === 0) {
        console.log(`  session: ${s.title}  (${s.id})  ${s.running ? '[RUNNING]' : '[stopped]'}`);
      }
      prev = { ...s, t: now };
    }

    prevCpu = cpu;
    n++;
    if (opt.samples && n >= opt.samples) break;
    await new Promise((r) => setTimeout(r, opt.interval * 1000));
  }

  console.log('');
  console.log('  Stopped. Highest threshold reached: ' + ['none', 'warning', 'critical'][worst]);
  process.exit(worst);
}

loop();
