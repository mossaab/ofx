#!/usr/bin/env node
// openfox-backup.cjs — COHERENT backup of sessions.db via SQLite's online backup API.
//
// WHY NOT A SIMPLE COPY: in WAL mode, copying `sessions.db` alone IGNORES the
// transactions already committed but not yet checkpointed into the main file (the
// WAL was 71 MB). SQLite's online backup API produces a single coherent file,
// even with the server running.
//
// USAGE
//   node openfox-backup.cjs                 # writes to ./backup/
//   node openfox-backup.cjs --out /path     # destination directory
//   node openfox-backup.cjs --keep 1        # keep only N backups (default: all)
//
// EXIT CODES: 0 = success, 1 = failure

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SQLITE_MODULE =
  process.env.OPENFOX_WD_SQLITE || '/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3';
const DB_PATH =
  process.env.OPENFOX_DB_PATH || path.join(process.env.HOME || '/home/mossaab', '.local/share/openfox/sessions.db');

const argv = process.argv.slice(2);
let OUTDIR = path.join(__dirname, 'backup');
let KEEP = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out' && argv[i + 1]) OUTDIR = argv[++i];
  else if (argv[i] === '--keep' && argv[i + 1]) KEEP = Number(argv[++i]);
}

const mb = (n) => (n / 1048576).toFixed(1);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

const Database = require(SQLITE_MODULE);

if (!fs.existsSync(DB_PATH)) {
  console.error('Database not found: ' + DB_PATH);
  process.exit(1);
}

fs.mkdirSync(OUTDIR, { recursive: true });
const DEST = path.join(OUTDIR, `sessions.db.${stamp}.bak`);

console.log('=== openfox-backup ===');
console.log('  source      : ' + DB_PATH);
console.log('  destination : ' + DEST);

const src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
src.pragma('query_only = true');

const state = src.prepare('SELECT COUNT(*) n FROM events').get();
const sessions = src.prepare('SELECT COUNT(*) n FROM sessions').get();
console.log(`  source state: ${state.n} events, ${sessions.n} sessions`);
console.log('  file        : ' + mb(fs.statSync(DB_PATH).size) + ' MB');

const t0 = Date.now();
let lastPct = -1;

src
  .backup(DEST, {
    progress(info) {
      const pct = info.totalPages ? 100 - Math.floor((info.remainingPages / info.totalPages) * 100) : 0;
      if (pct !== lastPct && pct % 25 === 0) {
        lastPct = pct;
        process.stdout.write(`  copying ${pct}% (${((Date.now() - t0) / 1000).toFixed(0)}s)\r`);
      }
      return 200;
    },
  })
  .then(() => {
    process.stdout.write(' '.repeat(40) + '\r');
    console.log(`  copy completed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log('  size        : ' + mb(fs.statSync(DEST).size) + ' MB');

    // verification of the copy
    const chk = new Database(DEST, { readonly: true, fileMustExist: true });
    chk.pragma('query_only = true');
    const integrity = chk.pragma('integrity_check', { simple: true });
    const e2 = chk.prepare('SELECT COUNT(*) n FROM events').get().n;
    const s2 = chk.prepare('SELECT COUNT(*) n FROM sessions').get().n;
    chk.close();

    console.log('');
    console.log('  --- backup verification ---');
    console.log('  integrity   : ' + integrity);
    console.log(`  events      : ${state.n} -> ${e2} ${e2 === state.n ? 'ok' : 'DIFFERENT'}`);
    console.log(`  sessions    : ${sessions.n} -> ${s2} ${s2 === sessions.n ? 'ok' : 'DIFFERENT'}`);

    // fingerprint, streamed to avoid loading 1.3 GB into memory
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(DEST);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => {
      const digest = hash.digest('hex');
      fs.writeFileSync(DEST + '.sha256', digest + '  ' + path.basename(DEST) + '\n');
      console.log('  sha256      : ' + digest);
      console.log('  fingerprint : ' + DEST + '.sha256');

      if (KEEP > 0) {
        const existing = fs
          .readdirSync(OUTDIR)
          .filter((f) => f.startsWith('sessions.db.') && f.endsWith('.bak'))
          .sort()
          .reverse();
        for (const old of existing.slice(KEEP)) {
          for (const suffix of ['', '.sha256']) {
            try {
              fs.unlinkSync(path.join(OUTDIR, old + suffix));
              console.log('  purge       : ' + old + suffix);
            } catch {}
          }
        }
      }

      const okAll = integrity === 'ok' && e2 === state.n && s2 === sessions.n;
      console.log('');
      console.log(okAll ? '  Backup valid.' : '  WARNING: verification incomplete.');
      src.close();
      console.log('');
      console.log('  To restore:');
      console.log('    sudo systemctl stop openfox.service   (or: kill -TERM <pid>)');
      console.log(`    cp "${DEST}" "${DB_PATH}"`);
      console.log('    sudo systemctl start openfox.service');
      process.exit(okAll ? 0 : 1);
    });
  })
  .catch((e) => {
    console.log('');
    console.log('  FAILURE: ' + e.message);
    try {
      src.close();
    } catch {}
    process.exit(1);
  });
