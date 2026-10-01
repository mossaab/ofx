# AGENTS.md — Guide for AI coding agents

## 1. Project Overview

`ofx` is a **command-line console for OpenFox**: it inspects, diagnoses and acts on
OpenFox sessions without going through the web UI. It exists because a runaway session
can make the UI unusable — exactly when you need a tool that does not depend on the UI.

Two-way data access:

- **Reads** OpenFox's SQLite event log (`sessions.db`) directly, always **read-only**.
- **Writes** only through OpenFox's HTTP API (so the server's in-memory caches stay
  coherent), except `compact --apply` which does offline work after a mandatory backup.

Tech stack:

- **Node.js CommonJS** (`.cjs`), **zero npm dependencies** — there is no `package.json`.
- `better-sqlite3` is a **native module borrowed from the OpenFox installation**
  (`/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3`); it is not
  installed here.
- **Bash** launcher + installer, `systemd`, `journalctl`, `/proc` — **Linux only**.
- No test framework, no lint config, no TypeScript. Verification is by syntax checks,
  a smoke test, and measurement scripts in `docs/repro/`.

The project was born from a post-mortem (incident narrative and root causes are in
`docs/`). Read `README.md` first — it documents the safety model and deliberate
non-goals; changing behavior often requires updating that README.

## 2. Directory Structure

```
ofx                    # bash LAUNCHER — entry point. Finds the node interpreter whose
                       #   ABI matches better-sqlite3, then execs ofx.cjs.
ofx.cjs                # THE main CLI (~3250 lines): all commands, help system, auth.
openfox-watchdog.sh    # health report + thresholds; delegated by `ofx diagnose`.
                       #   Single source of truth for OPENFOX_WD_* thresholds.
openfox-watchdog-db.cjs# DB metrics helper called by the watchdog (KEY=VALUE stdout).
openfox-session-watch.cjs  # live journal-growth monitor; delegated by `ofx watch`.
openfox-backup.cjs     # coherent online backup (SQLite backup API); `ofx backup`.
openfox-vacuum.cjs     # checkpoint WAL + VACUUM, server MUST be stopped; `ofx vacuum`.
install.sh             # symlinks ofx onto PATH, smoke-tests with `ofx status`.
docs/                  # incident analysis (README.md), bug report, prevention plan,
                       #   maintenance runbook, specs, docs/repro/*.cjs measurement scripts.
LICENSE, README.md     # MIT; README is the canonical product documentation (French,
                       #   like docs/ — the scripts themselves speak English).
```

Each helper script is **self-contained on purpose** (they duplicate small helpers like
`findHolders` and DB constants). Keep it that way: `ofx` delegates to them via
`runSibling()` so the behavior lives in one place, but each script must remain
runnable standalone.

## 3. Build, Lint, Test Commands

There is no build step and no package manager. Run everything directly with node/bash.

```bash
# Syntax check (the "lint" + "typecheck" of this repo):
node --check ofx.cjs openfox-backup.cjs openfox-session-watch.cjs \
  openfox-vacuum.cjs openfox-watchdog-db.cjs
bash -n ofx install.sh openfox-watchdog.sh

# Run the CLI (single "file"/command at a time):
./ofx status                 # smoke test: node + better-sqlite3 + DB all resolve
./ofx list
./ofx inspect --hot --fast   # --fast skips the heavy state-load measurement
./ofx help <command>         # built-in per-command help

# Single helper script (they take the same env vars):
node openfox-backup.cjs --out /tmp/bk --keep 1
node openfox-vacuum.cjs --dry-run
node openfox-session-watch.cjs --samples 3 --interval 5

# Install / uninstall on PATH:
./install.sh                 # symlinks into ~/.local/bin, runs `ofx status` smoke test
./install.sh --uninstall

# Regenerate the incident numbers (read-only measurements):
node docs/repro/repro-measure-state-load.cjs
node docs/repro/repro-explain-query-plans.cjs
```

**Exit-code contract for every script:** `0` success · `1` usage/precondition not met
· `2` operation failed. `watch`/`diagnose` overload it: 0 ok, 1 warn threshold,
2 critical threshold. Preserve this contract in any new command or helper.

**Key environment variables:** `OPENFOX_DB_PATH`, `OPENFOX_WD_SQLITE` (path to
better-sqlite3), `OPENFOX_HOST`/`OPENFOX_PORT` (API, default 127.0.0.1:10369),
`OPENFOX_SERVICE` (systemd unit, default `openfox`), `OPENFOX_DIR` (default
`/opt/openfox`), `OPENFOX_TOKEN` / `OPENFOX_PASSWORD` / `OPENFOX_TOKEN_FILE`,
`OPENFOX_REPO`, `OPENFOX_API_BODY_LIMIT_MB` (75), `OPENFOX_CTL_NODE`, and the
`OPENFOX_WD_*` thresholds defined at the top of `openfox-watchdog.sh`.

## 4. Code Conventions

- **CommonJS**: `require()`, `'use strict';` at the top of every `.cjs`. No ESM, no
  build tools, no external packages — use Node built-ins (`fs`, `path`, `child_process`,
  `readline`, global `fetch`).
- **User-facing strings are English** (help texts, messages, column headers) in every
  script — `ofx.cjs`, the helper `.cjs`, the `ofx` launcher, `openfox-watchdog.sh` and
  `install.sh`. Keep new user-visible text in English. Comments are English too; the
  French sources were translated, so the remaining French lives only in `README.md` and
  `docs/` (see below), never in code.
- **Output units are English-style**: byte labels are `MB`/`GB`/`KB` (not `Mo`/`Go`/`Ko`)
  and numbers are formatted with `toLocaleString('en-US')` — including the thresholds
  shown next to `LAG_MB_WARN`/`LAG_MB_CRIT`. Keep this consistent when adding output.
- **Two documentation languages**: `README.md` and `docs/` stay French, the code is
  English. A command whose help text changes needs the `HELP` table (English) *and* the
  README section (French) updated together — the README remains the canonical product
  documentation.
- Formatting: 2-space indent, single quotes, semicolons, trailing commas in multiline.
  No minification, no code golf — readability of the safety logic is the point.
- Display helpers in `ofx.cjs`: `ok()`, `ko()`, `warn()`, `info()`, `dim()`, `head()`,
  `rule()`, and the TTY-aware color object `C`. Use them; never emit raw `console.log`
  for status lines. Colors must stay no-op when stdout is not a TTY.
- Failure path: `fail(msg, code)` prints a ✗ line and exits. Prefer it over ad-hoc
  `process.exit` so output stays consistent.
- Command shape in `ofx.cjs`: each command is `cmdX(argv)` (or async), dispatched in the
  `switch` at the bottom of `main()`. Adding a command requires: the function, a `case`,
  an entry in the `HELP` table (`resume`, `usage`, `desc`, `options`, `examples`,
  `notes`), and usually a line in `usage()` and in `README.md`. Aliases live in `ALIASES`;
  typo suggestions come from `suggest()` (Levenshtein ≤ 2) — the HELP keys are the command
  vocabulary, so name them carefully.
- Arguments: parse with `positionalOf(argv, valueFlags)`, `optValue(argv, names)`,
  `selectorOf(argv)` — never use `argv[i]` index arithmetic directly; `valueFlags` must
  list flags that consume a following value (e.g. `-o`).
- SQL: **set-based queries only** (GROUP BY / JOIN), never per-session correlated
  subqueries — the DB can hold 200+ sessions and 100k+ events. Select only needed columns.
- Read-only DB access goes through `openDb()` in `ofx.cjs` (`readonly: true` +
  `PRAGMA query_only = true`). Sibling scripts repeat this pattern; keep both flags.
- Secrets: never log a token/password in full — use `fingerprint()` (prefix + length).
  Token file writes must stay atomic (tmp with mode 600 + `O_EXCL`, then rename) and the
  directory must be 700.
- `.gitignore` is strict: DB files, WAL/SHM, `backup/`, `*.token`, `*.openfox-session.json`,
  exports and logs are all ignored. Never commit runtime data or credentials.

## 5. Key Abstractions

- **Three-tier safety model** (the core design; see README):
  1. *Read-only* — direct SQLite reads (`list`, `inspect`, `plan`, `status`, `backup`…).
  2. *Writes via the HTTP API* (`stop`/`pause`/`resume`/`continue`/`new`/`rm`/`export`)
     so OpenFox's in-memory `snapshotCache`/`promptsCache` are invalidated properly.
  3. *Offline writes* — only `compact --apply`, and only after a backup that aborts the
     whole operation on failure. **Never write to sessions.db while the server runs.**
- **LAG is the metric**: bytes accumulated in a session *after its last
  `turn.snapshot`* event. Every state load re-reads exactly that volume, so LAG (in MB)
  — not event count (~82% of events are unavoidable thinking deltas) — predicts cost.
  Thresholds: warn > 20 MB, critical > 100 MB (`LAG_MB_WARN`/`LAG_MB_CRIT`).
- **Session selectors**: full id, unambiguous prefix, or `--hot` (the session with the
  largest LAG). Resolved by `resolveSession()`; ambiguous prefixes are rejected with a
  candidate list. Projects are resolved analogously by `resolveProject()`.
- **Consolidation eligibility**: `consolidationEligibility()` mirrors OpenFox's
  `EventStore.findOrphanedSessions()` — a session is consolidable only if stopped and
  `updated_at` older than `STALE_RUNNING_MS` (5 min) with an existing snapshot. It
  distinguishes *auto* blockers (cleared by a restart, since `initEventStore()` forces
  `is_running = 0`) from *blocking* ones (need human action). **If you change these
  rules, the server-side constants must stay identical** — the comments mark them.
- **`ofx` does not implement compaction.** The fold/consolidation is server-internal
  (`EventStore.consolidateSession`) and runs at server startup. `compact` only verifies
  eligibility, backs up, stops the session via the API, and orchestrates the restart.
  Re-implementing the fold in `ofx` would risk corrupting a session — do not.
- **Credential resolution order** (`apiToken()`): `OPENFOX_TOKEN` env → token file
  (`~/.config/ofx/token`, mode 600) → `OPENFOX_PASSWORD` (exchanged for a token via
  `POST /api/auth/login` on every call). Tokens are deterministic RSA signatures
  (base64 of RSA-SHA256 over sha256hex(password), keyed by `auth.key`) — no expiry.
  `auth login` **verifies the token against the API before writing it to disk**.
- **Export/import format**: `openfox-session` v1 (`EXPORT_FORMAT`/`EXPORT_VERSION`).
  Import validates format, version, presence of a `session.initialized` event, and size
  **before** sending; the server caps request bodies at 75 MB (`API_BODY_LIMIT_MB`,
  with a 1 MB margin) — an export above that cannot be re-imported. The HTTP API
  responds 201 on import success.
- **Delegation**: `runSibling(name, args)` executes helper scripts from `SCRIPT_DIR`
  (`.sh` with bash, `.cjs` with the current interpreter) and propagates their exit code.
  `watch`/`diagnose`/`backup`/`vacuum` are thin wrappers — change behavior in the helper,
  not in `ofx.cjs`.
- **Service lifecycle**: `svcDo()` wraps `sudo systemctl`; restart is deliberately
  `stop + sleep 1 + start` (the 1 s delay releases port 10369 and avoids documented
  EADDRINUSE). Destructive commands (`service install`, `service upgrade`) use
  `confirmDestructive()`: interactive TTY confirmation, **no `--yes` escape hatch**,
  and they refuse to run when stdin is not a terminal.
- **OpenFox API endpoints used**: `GET /api/health`, `GET /api/auth`,
  `POST /api/auth/login`, `POST|DELETE /api/sessions/:id/…` (stop, pause, resume,
  continue, export), `POST /api/sessions` (new), `POST /api/sessions/import`. Auth header:
  `x-session-token`. Deliberately NOT exposed: `POST …/message` (turns start via
  WebSocket; the HTTP endpoint only queues into an in-memory map that nothing drains) and
  `POST …/truncate` (destructive cut, not a compaction).

## 6. Common Pitfalls

- **better-sqlite3 ABI mismatch**: the native module is compiled for OpenFox's exact node
  version. Running helpers with a different `node` from PATH makes `require()` fail.
  That is why the `ofx` launcher resolves the interpreter from the running OpenFox
  process (and `runSibling` uses `process.execPath`). If it fails:
  `OPENFOX_CTL_NODE=/path/to/node`. Never `npm install` a second better-sqlite3 here.
- **Writing to SQLite while the server runs** leaves its in-memory snapshot/prompts
  caches stale — that is precisely the failure mode of the original incident. All writes
  go through the API (tier 2); only `compact --apply` works offline, after a backup.
- **Pre-checks before expensive side effects**: `compact --apply` checks eligibility and
  token availability *before* writing a (potentially huge) backup; `vacuum` refuses to run
  while any process holds the DB; `install` refuses while the service is active. Keep this
  ordering when adding steps — never do the expensive step first.
- **The 75 MB import ceiling**: a session can be exported fine and still be impossible to
  re-import. Check sizes before promising an import path; the refusal message should
  explain the limit, not surface a bare HTTP 413.
- **Backups are not `cp`**: in WAL mode a raw copy of `sessions.db` misses committed but
  un-checkpointed transactions. Always use SQLite's online backup API (`openfox-backup.cjs`).
- **VACUUM needs an exclusive lock**: server must be fully stopped, else it fails. The
  script detects holders via `/proc/*/fd` (no `lsof` dependency) — keep that technique on Linux.
- **Restart without the 1 s delay** can hit EADDRINUSE on port 10369. Use `svcRestart()` /
  the documented `stop && sleep 1 && start`.
- **Do not add an `ofx message` command**: `POST /api/sessions/:id/message` queues into an
  in-memory map with no HTTP-triggered drain (turns are started by WebSocket). It would
  report success while doing nothing. Same for provider/MCP/config endpoints — they belong
  in the UI.
- **Secrets**: masked prompts (`promptHidden`) refuse to run when stdin is not a TTY — a
  secret must never be pipeable. Token file: mode 600, atomic rename, `O_EXCL` temp. Do not
  relax these; do not print tokens in full (use `fingerprint()`).
- **N+1 queries** on the events table turn reads into stalls (that was half of the incident).
  New SQL must be set-based and select only needed columns.
- **Exit codes and TTY output**: preserve the 0/1/2 contract, keep colors TTY-gated, and
  keep destructive operations non-scriptable where intended (`service install/upgrade`),
  while `--yes` is allowed where it already exists (`compact`, `rm`, `vacuum`).
- **Documentation drift**: README.md documents every command, threshold and deliberate
  non-goal; the HELP table in ofx.cjs mirrors it. Update both (plus docs/ when incident
  facts change) with any behavior change.
- **The DB contains provider API keys** (`settings` table). `backup/`, `*.db*` and
  `*.openfox-session.json` are git-ignored for a reason — never commit them, never log the
  `settings` contents.
