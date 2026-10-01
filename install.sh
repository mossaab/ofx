#!/usr/bin/env bash
#
# ofx installer — puts `ofx` on your PATH and checks that it actually works.
#
# WHAT IT DOES
#   Creates a symlink  <prefix>/ofx  ->  <this repo>/ofx
#   Then runs `ofx status` to verify node, better-sqlite3 and the database.
#
# WHAT IT DOES NOT DO
#   No files are copied. No configuration is written. No service is touched.
#   Nothing outside <prefix>/ofx is created or modified.
#
# Idempotent: running it twice is harmless.
#
# USAGE
#   ./install.sh                      symlink into ~/.local/bin
#   ./install.sh --prefix /usr/local/bin
#   ./install.sh --uninstall          remove the symlink (only if it points here)
#   ./install.sh --no-verify          skip the smoke test
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PREFIX=""
UNINSTALL=0
VERIFY=1

# --- output helpers ---------------------------------------------------------
if [[ -t 1 ]]; then
  G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; X=$'\033[0m'
else
  G=''; R=''; Y=''; D=''; X=''
fi
ok()   { echo "  ${G}✓${X} $*"; }
ko()   { echo "  ${R}✗${X} $*"; }
warn() { echo "  ${Y}!${X} $*"; }
info() { echo "    $*"; }
dim()  { echo "    ${D}$*${X}"; }

usage() {
  cat <<EOF
ofx installer

  ./install.sh [--prefix DIR] [--no-verify]
  ./install.sh --uninstall [--prefix DIR]

  --prefix DIR    where to put the symlink (default: ~/.local/bin)
  --no-verify     skip the smoke test
  --uninstall     remove the symlink
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)     PREFIX="${2:-}"; shift 2 ;;
    --prefix=*)   PREFIX="${1#*=}"; shift ;;
    --uninstall|-u) UNINSTALL=1; shift ;;
    --no-verify)  VERIFY=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "ofx installer: unknown option '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

# --- default prefix ---------------------------------------------------------
if [[ -z "$PREFIX" ]]; then
  if [[ -d "$HOME/.local/bin" ]]; then
    PREFIX="$HOME/.local/bin"
  elif [[ -d "$HOME/bin" ]]; then
    PREFIX="$HOME/bin"
  else
    PREFIX="$HOME/.local/bin"
  fi
fi

LINK="$PREFIX/ofx"

echo
echo "  ofx installer"
echo "  ${D}repo   : $REPO_DIR${X}"
echo "  ${D}prefix : $PREFIX${X}"
echo "  ${D}link   : $LINK${X}"
echo

# --- uninstall --------------------------------------------------------------
if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ ! -e "$LINK" && ! -L "$LINK" ]]; then
    warn "nothing to remove: $LINK does not exist"
    echo
    exit 0
  fi
  if [[ ! -L "$LINK" ]]; then
    ko "$LINK exists and is NOT a symlink — refusing to delete a real file"
    info "remove it yourself if you are sure"
    echo
    exit 1
  fi
  # Only remove a link that points into this repo: never delete someone else's.
  TARGET="$(readlink -f "$LINK" 2>/dev/null || true)"
  case "$TARGET" in
    "$REPO_DIR"/*) ;;
    *) ko "$LINK points to $TARGET, which is outside this repo — refusing"
       echo
       exit 1 ;;
  esac
  rm -f "$LINK"
  ok "removed $LINK"
  echo
  exit 0
fi

# --- preconditions ----------------------------------------------------------
FAIL=0
for f in ofx ofx.cjs; do
  if [[ -f "$REPO_DIR/$f" ]]; then
    ok "$f present"
  else
    ko "$f missing in $REPO_DIR"
    FAIL=1
  fi
done
[[ "$FAIL" -eq 1 ]] && { echo; echo "  Incomplete checkout."; echo; exit 1; }

if [[ ! -x "$REPO_DIR/ofx" ]]; then
  chmod +x "$REPO_DIR/ofx" 2>/dev/null && ok "made ofx executable" || {
    ko "ofx is not executable and could not be chmod'ed"
    exit 1
  }
fi

# node must be findable; `ofx` resolves the interpreter itself, but say so early.
if ! command -v node >/dev/null 2>&1 && [[ ! -x "$HOME/.local/share/pi-node/current/bin/node" ]]; then
  warn "no node in PATH — ofx will rely on finding OpenFox's interpreter"
  dim "if it fails: OPENFOX_CTL_NODE=/path/to/node ofx status"
fi

# --- create the symlink -----------------------------------------------------
mkdir -p "$PREFIX" 2>/dev/null
if [[ ! -d "$PREFIX" ]]; then
  ko "cannot create $PREFIX (permissions?)"
  echo
  exit 1
fi

if [[ -L "$LINK" ]] || [[ ! -e "$LINK" ]]; then
  ln -sfn "$REPO_DIR/ofx" "$LINK" || { ko "symlink failed"; exit 1; }
  ok "symlinked $LINK -> $REPO_DIR/ofx"
else
  ko "$LINK already exists and is not a symlink — not touching it"
  info "move it aside, or use --prefix to install elsewhere"
  echo
  exit 1
fi

# --- PATH check -------------------------------------------------------------
case ":$PATH:" in
  *":$PREFIX:"*) ok "$PREFIX is on your PATH" ;;
  *)
    warn "$PREFIX is NOT on your PATH"
    info "add this to your shell profile:"
    dim "export PATH=\"$PREFIX:\$PATH\""
    ;;
esac

# --- smoke test -------------------------------------------------------------
if [[ "$VERIFY" -eq 1 ]]; then
  echo
  echo "  smoke test: ofx status"
  echo
  if "$LINK" status; then
    echo
    ok "ofx works"
  else
    echo
    ko "ofx status failed — see the output above"
    echo
    info "common causes:"
    dim "  - better-sqlite3 ABI mismatch: ofx uses OpenFox's own interpreter"
    dim "  - OpenFox not installed at /opt/openfox (override with OPENFOX_DIR)"
    dim "  - database elsewhere: export OPENFOX_DB_PATH=/path/to/sessions.db"
    echo
    exit 1
  fi
fi

# --- next steps -------------------------------------------------------------
echo
echo "  ${G}Done.${X}"
echo
echo "  Try:"
echo "    ofx status            # everything at a glance"
echo "    ofx list              # sessions and their snapshot lag"
echo "    ofx inspect --hot     # the worst one, in detail"
echo
echo "  To act on a session you need a token:"
echo "    ofx auth login        # masked password prompt, stored with mode 600"
echo
