#!/usr/bin/env bash
#
# openfox-watchdog.sh — detection of OpenFox event-journal pathologies
#
# Detects the spiral documented in POURQUOI-ET-PREVENTION.md:
#   growing journal -> 950 MB state loads -> saturated CPU on the
#   main thread -> the UI can no longer stop the session -> RAM at the V8 ceiling.
#
# PRINCIPLE: CPU is measured as an INSTANTANEOUS value (jiffies delta on /proc/<pid>/stat).
# The %CPU from `ps` is an average since startup: it is misleading and unusable
# here (it still showed 97% after the load had dropped back to 0%).
#
# The script is 100% READ-ONLY: no write into OpenFox, no kill,
# no configuration change. The database is opened with `readonly` + `query_only`.
#
# Output: readable report on stdout, exit code 0 = OK, 1 = WARN, 2 = CRITICAL.
#
# Usage:
#   ./openfox-watchdog.sh                 # one-shot check
#   OPENFOX_WD_QUIET=1 ./openfox-watchdog.sh   # prints nothing if OK (for cron)
#
set -uo pipefail

# ----------------------------------------------------------------------------
# Thresholds (overridable via environment variables)
# ----------------------------------------------------------------------------
SAMPLE_SECONDS="${OPENFOX_WD_SAMPLE_SECONDS:-10}"        # CPU/IO measurement window
RSS_WARN_GB="${OPENFOX_WD_RSS_WARN_GB:-4}"               # process RSS
HWM_WARN_PCT="${OPENFOX_WD_HWM_WARN_PCT:-90}"            # % of the V8 heap limit
CPU_WARN_PCT="${OPENFOX_WD_CPU_WARN_PCT:-50}"            # CPU load considered abnormal
IDLE_GRACE_S="${OPENFOX_WD_IDLE_GRACE_S:-120}"           # no new event for N seconds
DB_SIZE_WARN_MB="${OPENFOX_WD_DB_SIZE_WARN_MB:-300}"     # size of sessions.db
SESSION_EVENTS_WARN="${OPENFOX_WD_SESSION_EVENTS_WARN:-20000}"
SESSION_PAYLOAD_WARN_MB="${OPENFOX_WD_SESSION_PAYLOAD_WARN_MB:-200}"
# Most predictive metric: BYTES accumulated SINCE the last snapshot.
# Beyond that, getEventsSinceSnapshot() re-reads the whole journal on every state load.
# Reference point: 20 MB -> loads start to cost; 953 MB -> 6.9 s each.
# (Counting events is a poor proxy: ~82% are thinking deltas, unavoidable.)
LAG_MB_WARN="${OPENFOX_WD_LAG_MB_WARN:-20}"
LAG_MB_CRIT="${OPENFOX_WD_LAG_MB_CRIT:-100}"
# Secondary, very high guardrail: a session with more than 100 000 events is abnormal.
EVENTS_SINCE_SNAPSHOT_WARN="${OPENFOX_WD_SINCE_SNAPSHOT_WARN:-100000}"
VACUUM_WARN_MB="${OPENFOX_WD_VACUUM_WARN_MB:-100}"     # free pages justifying a VACUUM
LOG_FILE="${OPENFOX_WD_LOG:-}"                           # e.g. ~/.openfox/watchdog.log
QUIET="${OPENFOX_WD_QUIET:-0}"

OPENFOX_DIR="${OPENFOX_DIR:-$HOME/.openfox}"
DATA_DIR="${OPENFOX_DATA_DIR:-$HOME/.local/share/openfox}"
DB_PATH="${OPENFOX_DB_PATH:-$DATA_DIR/sessions.db}"

# ----------------------------------------------------------------------------
# Locating the OpenFox process
# ----------------------------------------------------------------------------
# The launcher (node bin/openfox) and the real server share the same cmdline: keep
# the one with the largest RSS (the server = hundreds of MB/GB, the launcher ~50 MB).
find_pid() {
  local best="" bestrss=0 p rss
  while read -r p; do
    [[ -r "/proc/$p/cmdline" ]] || continue
    tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | grep -q 'bin/openfox' || continue
    [[ -d "/proc/$p" ]] || continue
    rss="$(awk '/VmRSS/{print $2}' "/proc/$p/status" 2>/dev/null)"
    if [[ -n "$rss" && "$rss" -gt "$bestrss" ]]; then bestrss="$rss"; best="$p"; fi
  done < <(pgrep -f 'bin/openfox' 2>/dev/null)

  if [[ -z "$best" && -r "$OPENFOX_DIR/openfox.pid" ]]; then
    p="$(tr -dc '0-9' < "$OPENFOX_DIR/openfox.pid")"
    [[ -n "$p" && -d "/proc/$p" ]] && best="$p"
  fi
  [[ -n "$best" ]] && echo "$best"
}

PID="$(find_pid)"

LEVEL=0            # 0 ok, 1 warn, 2 critical
declare -a ALERTS=()

add_alert() {
  local lvl="$1"; shift
  [[ "$lvl" -gt "$LEVEL" ]] && LEVEL="$lvl"
  ALERTS+=("$*")
}

# ----------------------------------------------------------------------------
# Process metrics
# ----------------------------------------------------------------------------
PROC_CPU_PCT="-"
PROC_RSS_GB="-"
PROC_RSS_MB="-"
PROC_HWM_GB="-"
PROC_MEM_PCT="-"
PROC_HEAP_GB="-"
PROC_READ_MBPS="-"
PROC_STATE="-"
PROC_ELAPSED="-"

if [[ -n "${PID:-}" && -d "/proc/$PID" ]]; then
  j1="$(awk '{print $14+$15}' "/proc/$PID/stat" 2>/dev/null)"
  r1="$(awk '/^rchar/{print $2}' "/proc/$PID/io" 2>/dev/null)"
  sleep "$SAMPLE_SECONDS"
  j2="$(awk '{print $14+$15}' "/proc/$PID/stat" 2>/dev/null)"
  r2="$(awk '/^rchar/{print $2}' "/proc/$PID/io" 2>/dev/null)"

  if [[ -n "$j1" && -n "$j2" ]]; then
    PROC_CPU_PCT="$(( (j2 - j1) * 100 / (SAMPLE_SECONDS * 100) ))"
  fi
  if [[ -n "$r1" && -n "$r2" ]]; then
    PROC_READ_MBPS="$(( (r2 - r1) / 1048576 / SAMPLE_SECONDS ))"
  fi

  PROC_RSS_GB="$(awk '/VmRSS/{printf "%.2f", $2/1048576}' "/proc/$PID/status" 2>/dev/null)"
  PROC_RSS_MB="$(awk '/VmRSS/{printf "%d", $2/1024}' "/proc/$PID/status" 2>/dev/null)"
  PROC_HWM_GB="$(awk '/VmHWM/{printf "%.2f", $2/1048576}' "/proc/$PID/status" 2>/dev/null)"
  PROC_STATE="$(awk '/^State:/{print $2}' "/proc/$PID/status" 2>/dev/null)"
  PROC_ELAPSED="$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ')"

  # --max-old-space-size is expressed in MB (8192 = 8 GB)
  heap_mb="$(tr '\0' '\n' < "/proc/$PID/cmdline" 2>/dev/null | sed -n 's/^--max-old-space-size=\([0-9]*\)$/\1/p' | head -1)"
  if [[ -n "$heap_mb" ]]; then
    PROC_HEAP_GB="$(awk -v m="$heap_mb" 'BEGIN{printf "%.0f", m/1024}')"
    # Compare the CURRENT RSS to the limit: VmHWM is a historical peak and would stay
    # above the threshold indefinitely after an incident (permanent false alert).
    PROC_MEM_PCT="$(awk -v r="$PROC_RSS_MB" -v m="$heap_mb" 'BEGIN{ if (m>0) printf "%d", (r/m)*100; else print "-" }')"
  fi
else
  add_alert 1 "PROCESS MISSING: no OpenFox process found (server stopped or unfindable)"
fi

# ----------------------------------------------------------------------------
# Database metrics (read-only)
# ----------------------------------------------------------------------------
DB_TOTAL_EVENTS="-"; DB_MAX_SESS_ID="-"; DB_MAX_SESS_EVENTS="-"
DB_MAX_SESS_MB="-"; DB_LAST_EVENT_AGE_S="-"; DB_RECLAIMABLE_MB="-"
DB_SIZE_MB="-"; DB_WAL_MB="-"; DB_RUNNING_SESSIONS="-"
DB_FOCUS_ID="-"; DB_FOCUS_TITLE="-"; DB_FOCUS_RUNNING="-"; DB_FOCUS_EVENTS="-"
DB_FOCUS_MB="-"; DB_FOCUS_SNAPSHOTS="-"; DB_FOCUS_LAG="-"; DB_FOCUS_LAG_MB="-"
DB_MAX_LAG="-"; DB_MAX_LAG_MB="-"; DB_MAX_LAG_SESSION="-"; DB_LIVE_MB="-"
DB_BIGGEST_ID="-"; DB_BIGGEST_EVENTS="-"; DB_BIGGEST_MB="-"

if [[ -f "$DB_PATH" ]]; then
  DB_SIZE_MB="$(( $(stat -c %s "$DB_PATH") / 1048576 ))"
  [[ -f "$DB_PATH-wal" ]] && DB_WAL_MB="$(( $(stat -c %s "$DB_PATH-wal") / 1048576 ))"

  # Node interpreter: the one running openfox if possible, otherwise PATH
  NODE_BIN="${OPENFOX_WD_NODE:-}"
  if [[ -z "$NODE_BIN" && -n "${PID:-}" && -r "/proc/$PID/cmdline" ]]; then
    cand="$(tr '\0' '\n' < "/proc/$PID/cmdline" | head -1)"
    [[ -x "$cand" ]] && NODE_BIN="$cand"
  fi
  [[ -z "$NODE_BIN" ]] && NODE_BIN="$(command -v node || true)"
  [[ -z "$NODE_BIN" && -x "$HOME/.local/share/pi-node/current/bin/node" ]] \
    && NODE_BIN="$HOME/.local/share/pi-node/current/bin/node"

  SQLITE_MODULE="${OPENFOX_WD_SQLITE:-/opt/openfox/lib/node_modules/openfox/node_modules/better-sqlite3}"
  WD_HELPER="$(dirname "$(readlink -f "$0")")/openfox-watchdog-db.cjs"
  if [[ -n "$NODE_BIN" && -e "$SQLITE_MODULE" && -f "$WD_HELPER" ]]; then
    dbstats="$(env WD_DB="$DB_PATH" WD_SQLITE="$SQLITE_MODULE" "$NODE_BIN" "$WD_HELPER" 2>/dev/null)"

    while IFS='=' read -r k v; do
      case "$k" in
        DB_TOTAL_EVENTS)      DB_TOTAL_EVENTS="$v" ;;
        DB_LAST_EVENT_AGE_S)  DB_LAST_EVENT_AGE_S="$v" ;;
        DB_RECLAIMABLE_MB)    DB_RECLAIMABLE_MB="$v" ;;
        DB_RUNNING_SESSIONS)  DB_RUNNING_SESSIONS="$v" ;;
        DB_FOCUS_ID)          DB_FOCUS_ID="$v" ;;
        DB_FOCUS_TITLE)       DB_FOCUS_TITLE="$v" ;;
        DB_FOCUS_RUNNING)     DB_FOCUS_RUNNING="$v" ;;
        DB_FOCUS_EVENTS)      DB_FOCUS_EVENTS="$v" ;;
        DB_FOCUS_MB)          DB_FOCUS_MB="$v" ;;
        DB_FOCUS_SNAPSHOTS)   DB_FOCUS_SNAPSHOTS="$v" ;;
        DB_FOCUS_LAG)         DB_FOCUS_LAG="$v" ;;
        DB_FOCUS_LAG_MB)      DB_FOCUS_LAG_MB="$v" ;;
        DB_MAX_LAG)           DB_MAX_LAG="$v" ;;
        DB_MAX_LAG_MB)        DB_MAX_LAG_MB="$v" ;;
        DB_MAX_LAG_SESSION)   DB_MAX_LAG_SESSION="$v" ;;
        DB_LIVE_MB)           DB_LIVE_MB="$v" ;;
        DB_BIGGEST_ID)        DB_BIGGEST_ID="$v" ;;
        DB_BIGGEST_EVENTS)    DB_BIGGEST_EVENTS="$v" ;;
        DB_BIGGEST_MB)        DB_BIGGEST_MB="$v" ;;
        DB_ERROR)             add_alert 1 "DATABASE UNREADABLE: $v" ;;
      esac
    done <<< "$dbstats"
  else
    add_alert 1 "Database metrics unavailable: node, better-sqlite3 or $WD_HELPER not found"
  fi
else
  add_alert 1 "DATABASE MISSING: $DB_PATH not found"
fi

# ----------------------------------------------------------------------------
# Rules
# ----------------------------------------------------------------------------
if [[ "$DB_LIVE_MB" != "-" ]] && awk -v a="$DB_LIVE_MB" -v b="$DB_SIZE_WARN_MB" 'BEGIN{exit !(a>b)}'; then
  add_alert 1 "GROWING DATA: ${DB_LIVE_MB} MB of real data (> ${DB_SIZE_WARN_MB} MB)"
fi

if [[ "$DB_FOCUS_EVENTS" != "-" && "$DB_FOCUS_EVENTS" != "0" && "$DB_FOCUS_EVENTS" -gt "$SESSION_EVENTS_WARN" ]]; then
  add_alert 2 "LARGE SESSION JOURNAL: $DB_FOCUS_EVENTS events for $DB_FOCUS_ID (> ${SESSION_EVENTS_WARN})"
fi

if [[ "$DB_BIGGEST_MB" != "-" ]] && awk -v a="$DB_BIGGEST_MB" -v b="$SESSION_PAYLOAD_WARN_MB" 'BEGIN{exit !(a>b)}'; then
  add_alert 2 "LARGE SESSION PAYLOAD: ${DB_BIGGEST_MB} MB for $DB_BIGGEST_ID (> ${SESSION_PAYLOAD_WARN_MB} MB)"
fi

# The earliest and best-calibrated signal: the VOLUME (bytes) accumulated since the last
# snapshot. It is what turned a 12 h turn into a spiral (953 MB after a
# single snapshot at seq 5067 for 325 000 events). Measured on ALL sessions.
if [[ "$DB_MAX_LAG_MB" != "-" && "$DB_MAX_LAG_MB" != "0" ]]; then
  if awk -v a="$DB_MAX_LAG_MB" -v b="$LAG_MB_CRIT" 'BEGIN{exit !(a>b)}'; then
    add_alert 2 "SNAPSHOT VERY BEHIND: ${DB_MAX_LAG_MB} MB accumulated since the last snapshot of session $DB_MAX_LAG_SESSION — every state load re-reads that whole volume. COMPACT this session NOW."
  elif awk -v a="$DB_MAX_LAG_MB" -v b="$LAG_MB_WARN" 'BEGIN{exit !(a>b)}'; then
    add_alert 1 "SNAPSHOT BEHIND: ${DB_MAX_LAG_MB} MB accumulated since the last snapshot of session $DB_MAX_LAG_SESSION (> ${LAG_MB_WARN} MB) — compact as soon as the turn ends."
  fi
fi

if [[ "$DB_MAX_LAG" != "-" && "$DB_MAX_LAG" != "0" && "$DB_MAX_LAG" -gt "$EVENTS_SINCE_SNAPSHOT_WARN" ]]; then
  add_alert 1 "ABNORMAL SESSION JOURNAL: $DB_MAX_LAG events since the last snapshot of $DB_MAX_LAG_SESSION (> ${EVENTS_SINCE_SNAPSHOT_WARN})"
fi

if [[ "$PROC_RSS_GB" != "-" ]] && awk -v a="$PROC_RSS_GB" -v b="$RSS_WARN_GB" 'BEGIN{exit !(a>b)}'; then
  add_alert 1 "HIGH MEMORY: RSS = ${PROC_RSS_GB} GB (> ${RSS_WARN_GB} GB)"
fi

if [[ "$PROC_MEM_PCT" != "-" && "$PROC_MEM_PCT" != "0" && "$PROC_MEM_PCT" -ge "HWM_WARN_PCT" ]]; then
  add_alert 2 "MEMORY AT LIMIT: RSS = ${PROC_RSS_GB} GB = ${PROC_MEM_PCT}% of the V8 limit (${PROC_HEAP_GB} GB) — OOM risk"
fi

# Signature of the spiral: saturated CPU while the agent no longer writes anything.
# This is the symptom seen on 26/09: the UI triggers 950 MB reloads in a loop.
if [[ "$PROC_CPU_PCT" != "-" && "$CPU_WARN_PCT" -gt 0 && "$PROC_CPU_PCT" -ge "$CPU_WARN_PCT" ]]; then
  if [[ "$DB_LAST_EVENT_AGE_S" != "-" && "$DB_LAST_EVENT_AGE_S" -ge "$IDLE_GRACE_S" ]]; then
    add_alert 2 "SPIRAL IN PROGRESS: CPU ${PROC_CPU_PCT}% and no new event for ${DB_LAST_EVENT_AGE_S} s — state loads in a loop (the agent is NOT the cause). Compact the session to force a snapshot and the purge."
  else
    add_alert 1 "HIGH CPU: ${PROC_CPU_PCT}% of one core (recent agent activity: ${DB_LAST_EVENT_AGE_S} s)"
  fi
fi

if [[ "$DB_RECLAIMABLE_MB" != "-" ]] && awk -v a="$DB_RECLAIMABLE_MB" -v b="$VACUUM_WARN_MB" 'BEGIN{exit !(a>b)}'; then
  add_alert 1 "RECLAIMABLE SPACE: ${DB_RECLAIMABLE_MB} MB of free pages — a VACUUM would return them"
fi

# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------
if [[ "$LEVEL" -eq 0 && "$QUIET" == "1" ]]; then exit 0; fi

case "$LEVEL" in
  0) HEAD="OK" ;;
  1) HEAD="WARN" ;;
  *) HEAD="CRITICAL" ;;
esac

REPORT="$(
  {
    echo "[$HEAD] openfox-watchdog  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "  process  : pid=${PID:--}  state=${PROC_STATE}  uptime=${PROC_ELAPSED}"
    echo "  cpu      : ${PROC_CPU_PCT}% of one core (instantaneous, ${SAMPLE_SECONDS}s)"
    echo "  read     : ${PROC_READ_MBPS} MB/s from the page cache"
    echo "  memory   : RSS ${PROC_RSS_GB} GB (${PROC_MEM_PCT}% of the V8 limit ${PROC_HEAP_GB:-?} GB) | historical peak ${PROC_HWM_GB} GB"
    echo "  database : sessions.db ${DB_SIZE_MB} MB (real data ${DB_LIVE_MB} MB) | wal ${DB_WAL_MB} MB | ${DB_TOTAL_EVENTS} events | active sessions ${DB_RUNNING_SESSIONS}"
    echo "  session  : ${DB_FOCUS_EVENTS} events / ${DB_FOCUS_MB} MB  (${DB_FOCUS_ID}$([[ "$DB_FOCUS_RUNNING" == "1" ]] && echo ', RUNNING')) — ${DB_FOCUS_SNAPSHOTS} snapshot(s)"
    echo "  snapshot : ${DB_MAX_LAG_MB} MB / ${DB_MAX_LAG} events accumulated since the last snapshot (${DB_MAX_LAG_SESSION})"
    echo "  activity : last event ${DB_LAST_EVENT_AGE_S} s ago"
    echo "  vacuum   : ${DB_RECLAIMABLE_MB} MB reclaimable"
    if [[ ${#ALERTS[@]} -gt 0 ]]; then
      echo "  ---- alerts ----"
      for a in "${ALERTS[@]}"; do echo "  * $a"; done
    fi
  }
)"

echo "$REPORT"
if [[ -n "$LOG_FILE" ]]; then
  echo "$REPORT" >> "$LOG_FILE"
fi

exit "$LEVEL"
