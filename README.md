# ofx

A command-line console for **OpenFox**: inspect, diagnose and act on sessions without
going through the web UI.

`ofx` reads OpenFox's SQLite event log directly (read-only), and uses OpenFox's own HTTP
API for anything that writes. It exists because a runaway session can make the UI
unusable — and that is exactly when you need a tool that does not depend on the UI.

---

## Why this exists

OpenFox stores every session as an append-only event log in SQLite. Two design
properties make that log grow far faster than the work it describes:

1. **`tool.preparing` is written once per streamed fragment, each carrying the
   *accumulated* JSON arguments.** So a tool call whose arguments end up 29 KB long
   emits thousands of events whose payloads are progressively longer prefixes of the
   same string. The write cost is quadratic in the argument size.
2. **`turn.snapshot` is only written when a whole turn resolves.** A turn that runs for
   hours writes no snapshot and triggers no cleanup for its entire duration.

The read side then turns that into a stall. `getEvents()` is called **without** a
`fromSeq` bound, so it re-reads the entire journal; and because `better-sqlite3` is
synchronous, that read blocks the main thread — including the HTTP server.

Measured on a real incident (OpenFox 2.0.160, one session):

| Metric | Value |
|---|---|
| Session event log | **111,808 events / 210 MB**, a single `turn.snapshot` |
| Cost of *one* state load | **876 ms**, re-reading 203 MB |
| `getLatestSnapshot()` | **~32–45 ms**, walking 83,337 index entries to find one row |
| `getEvents()` with `fromSeq` vs without | 747 ms vs 877 ms — the snapshot was too old to help |
| `tool.preparing` events for 243 real tool calls | **59,913** — a **864×** inflation, 203 MB of the 210 MB |
| Fragments written for a **single** tool call | **6,473** — 84 MB stored where 28 KB would do |

`ofx` was built to make that visible, to prove it with numbers, and to act on it safely.

---

## Requirements

- **Linux** (reads `/proc`, uses `systemctl` for the service lifecycle)
- **Node.js** — the same interpreter that runs OpenFox. `better-sqlite3` is a native
  module, so an ABI mismatch makes `require()` fail. The `ofx` launcher finds the right
  interpreter automatically from the running OpenFox process.
- **OpenFox installed** at `/opt/openfox` (the default; overridable via `OPENFOX_DIR`)
- Optionally: a `systemd` unit named `openfox`

`ofx` has **no npm dependencies**. It reuses the `better-sqlite3` that OpenFox already
ships.

---

## Install

```bash
git clone <this-repo> ~/projects/ofx
cd ~/projects/ofx
./install.sh
```

`install.sh` symlinks `ofx` into a directory on your `PATH` (default `~/.local/bin`),
checks that the native module resolves, runs a smoke test, and explains how to
authenticate. It is idempotent and does not copy files.

```bash
./install.sh --prefix /usr/local/bin   # install elsewhere
./install.sh --uninstall               # remove the symlink
```

---

## Quick start

```bash
ofx status              # service, process, API, database — one screen
ofx list                # sessions, sorted by snapshot lag
ofx inspect --hot       # the worst session, in detail
ofx plan --hot          # what a compaction would do (dry-run, changes nothing)
```

Everything above is read-only and needs no credentials.

To act on a session, authenticate once:

```bash
ofx auth login          # masked password prompt -> token stored with mode 600
```

```bash
ofx stop --hot          # stop the running turn of the worst session
ofx export --hot        # archive it to a file first
ofx compact --hot --apply --restart
```

---

## Commands

### Read-only — no credentials, no writes

| Command | What it does |
|---|---|
| `status` | systemd unit, processes, API reachability, DB size/WAL/holders, session lag |
| `list [--all]` | sessions with event count, payload size, snapshot count, lag |
| `inspect <id\|--hot> [--fast]` | per-type breakdown, snapshot positions, real state-load cost |
| `plan <id\|--hot>` | dry-run of a consolidation: eligibility, what survives, what is lost |
| `watch` | live journal growth rate |
| `diagnose` | full health report with thresholds, exit 0/1/2 |
| `backup [--out DIR] [--keep N]` | coherent DB backup via SQLite's online backup API |
| `vacuum [--dry-run] [--yes]` | checkpoint + VACUUM (**server must be stopped**) |

### Actions — via the HTTP API, token required

| Command | Endpoint |
|---|---|
| `stop <id>` | `POST /api/sessions/:id/stop` |
| `pause <id>` / `resume <id>` | `POST /api/sessions/:id/pause` / `resume` |
| `continue <id>` | `POST /api/sessions/:id/continue` |
| `export <id> [-o FILE]` | `GET /api/sessions/:id/export` — writes nothing to the session |
| `import <FILE> --project <id>` | `POST /api/sessions/import` — **creates** a new session |
| `new --project <id> [--title T]` | `POST /api/sessions` |
| `rm <id> [--yes]` | `DELETE /api/sessions/:id` — **definitive** |

### Export / import, and a hard limit

An export contains everything needed to recreate the session: the source metadata, the
cached layout, the messages, and the **raw event log**. `ofx export` is read-only;
`ofx import` creates a *new* session and leaves the original alone.

The import path has a ceiling. OpenFox caps HTTP request bodies at 75 MB:

```js
app.use(express.json({ limit: "75mb" }));   // dist/chunk-2J6OW67H.js:8608
```

A session whose export exceeds that can be exported but **not re-imported**. `ofx import`
measures the file before sending and refuses with an explanation, rather than letting the
server fail with a bare HTTP 413.

> On the instance this tool came from, one session reached 80,367 events / 64.5 MB and
> produced a **76.3 MB export — already past the limit, and still growing**. An archive
> taken too late is a one-way file. Export while the session is still small, and keep an
> eye on `ofx list`.

### Credentials

| Command | What it does |
|---|---|
| `auth login` | masked password prompt, exchanges it for a token, verifies it, stores it 600 |
| `auth set-token` | paste an existing token |
| `auth status` | which credential source would be used, and under what permissions |
| `auth check` | verify the credentials against the API |
| `auth clear` | delete the stored token |

Resolution order: `OPENFOX_TOKEN` → token file → `OPENFOX_PASSWORD`.

### Service lifecycle

| Command | What it does |
|---|---|
| `service start\|stop\|restart\|status` | drive the `openfox` systemd unit |
| `service install [version]` | **destructive** — `rm -rf /opt/openfox` then `npm install -g` |
| `service upgrade` | **destructive** — stop, reinstall, start |
| `logs [N] [-f]` | `journalctl -u openfox`, falling back to the log file |

`service install` and `service upgrade` execute a `sudo rm -rf` on the install
directory. They require an **interactive confirmation that cannot be bypassed**, and
`install` refuses to run while the service is active.

### Compaction

```bash
ofx compact <id>                      # dry-run: exactly like `plan`
ofx compact <id> --apply              # backup, then stop the session via the API
ofx compact <id> --apply --restart    # …then restart the service
```

`ofx` **does not implement compaction**. Consolidation is OpenFox's own code
(`EventStore.consolidateSession`) and runs automatically at server startup. Replaying
its fold from the outside would risk corrupting a session. `ofx` verifies eligibility
and orchestrates the restart instead.

---

## Safety model

Three independent tiers, in increasing order of consequence:

**1. Read-only.** `list`, `inspect`, `plan`, `status`, `backup`, `watch`, `diagnose`
open the database with `readonly: true` **and** `PRAGMA query_only = true`. No writes,
no locks held, no `kill`.

**2. Writes through the API.** `stop`, `pause`, `resume`, `continue`, `new`, `rm`,
`export`. OpenFox keeps `snapshotCache` and `promptsCache` **in memory** and only
invalidates them on writes that pass through it. Writing to SQLite from outside would
leave those caches stale — which is precisely the failure mode of the original
incident. So `ofx` never does that.

**3. Offline writes.** Only `compact --apply`, and only after a mandatory backup that
aborts the whole operation if it fails.

Additional guarantees:

- `compact` runs its pre-checks **before** the backup, so it never writes a 700 MB
  backup for an operation that cannot proceed.
- `auth login` verifies the token against the API **before** writing it to disk. A
  stored token that does not work fails later and elsewhere.
- The token file is created via `O_EXCL` with mode `600` and then renamed, so it is
  never readable by anyone else, not even momentarily.
- Masked prompts read in raw terminal mode and refuse to run when stdin is not a TTY.
  A secret cannot be piped in.

---

## Why it is fast where OpenFox is slow

`ofx` reads with **set-based queries** instead of per-session correlated subqueries: on a
232-session database, `list` issues a handful of grouped queries against `events`, not
232 × N lookups. And it only ever reads the columns it needs.

The measurement that matters is not `ofx`'s own speed, though — it is that the numbers
it prints explain a 210 MB regression that was invisible from inside the UI.

---

## What it deliberately does not do

- **`ofx message`.** `POST /api/sessions/:id/message` calls `queueMessage()`, which only
  pushes into an in-memory `Map`. Nothing starts a turn from HTTP: `/chat` and
  `/continue` are validation stubs that return `{accepted:true}` without doing anything.
  Turns are started by a **WebSocket** client message. A `message` command over HTTP
  would queue into a structure nothing drains, and report `success: true` while doing
  nothing. Shipping that would be worse than not shipping it.
- **`POST /api/sessions/:id/truncate`.** This cuts the conversation with
  `deleteEventsAfterSeq`. It is not a compaction, and it is destructive. Use the UI.
- **Provider, MCP and config endpoints.** These are settings. They belong in the UI, and
  exposing them on the command line multiplies the ways to break a working setup.

---

## Background

This tool is the product of a post-mortem on a real incident: an OpenFox instance pinned
a CPU core for 9h30 and became unstoppable from its own UI.

The detailed analysis is in [`docs/`](docs/):

- [`docs/README.md`](docs/README.md) — the incident narrative, before/after
- [`docs/OPENFOX-BUG-REPORT.md`](docs/OPENFOX-BUG-REPORT.md) — root causes with query plans
- [`docs/POURQUOI-ET-PREVENTION.md`](docs/POURQUOI-ET-PREVENTION.md) — the causal chain
- [`docs/PROCEDURE-MAINTENANCE-OPENFOX.md`](docs/PROCEDURE-MAINTENANCE-OPENFOX.md) — operational runbook
- [`docs/repro/`](docs/repro/) — scripts that regenerate the numbers quoted above

---

## License

MIT — see [LICENSE](LICENSE).
