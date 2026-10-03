#!/usr/bin/env bash
# Local (non-Docker) Postgres clusters for qopt, using Homebrew's postgresql@17.
#
#   target  :5433  the database being tuned (pg_stat_statements + auto_explain)
#   shadow  :5434  lab copy where suggestions are actually executed
#   meta    :5435  qopt's own storage (doc chunks + embeddings, analysis runs)
#
# Usage: scripts/local-db.sh init|start|stop|status|destroy
# Data lives in ./.pgdata — nothing is installed as a background service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.pgdata"
PGBIN="${PGBIN:-$(brew --prefix postgresql@17 2>/dev/null)/bin}"
SLOW_MS="${QOPT_SLOW_MS:-5}"
# macOS: the postmaster refuses to start ("became multithreaded") without a valid LC_ALL.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

CLUSTERS=(target shadow meta)
port_of() { case "$1" in target) echo 5433 ;; shadow) echo 5434 ;; meta) echo 5435 ;; esac; }

require_bin() {
  if [[ ! -x "$PGBIN/pg_ctl" ]]; then
    echo "pg_ctl not found in $PGBIN. Install with: brew install postgresql@17 (or set PGBIN)." >&2
    exit 1
  fi
}

write_conf() {
  local name="$1" dir="$DATA/$1" port
  port="$(port_of "$name")"
  cat >>"$dir/postgresql.conf" <<EOF

# ---- qopt ($name) ----
port = $port
listen_addresses = 'localhost'
max_connections = 50
shared_buffers = 256MB
track_io_timing = on
EOF
  if [[ "$name" == "target" ]]; then
    cat >>"$dir/postgresql.conf" <<EOF
shared_preload_libraries = 'pg_stat_statements,auto_explain'
compute_query_id = on
pg_stat_statements.track = top
pg_stat_statements.track_utility = off
auto_explain.log_min_duration = '${SLOW_MS}ms'
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_timing = on
auto_explain.log_verbose = on
auto_explain.log_format = json
logging_collector = on
log_destination = 'jsonlog'
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d.log'
log_rotation_size = 100MB
EOF
  fi
}

cmd_init() {
  require_bin
  mkdir -p "$DATA"
  for c in "${CLUSTERS[@]}"; do
    if [[ -f "$DATA/$c/PG_VERSION" ]]; then
      echo "[$c] already initialized"
      continue
    fi
    "$PGBIN/initdb" -D "$DATA/$c" -U postgres --auth=trust --encoding=UTF8 --locale=en_US.UTF-8 >/dev/null
    write_conf "$c"
    echo "[$c] initialized on port $(port_of "$c")"
  done
  cmd_start
  for c in "${CLUSTERS[@]}"; do
    "$PGBIN/psql" -q -h localhost -p "$(port_of "$c")" -U postgres -d postgres \
      -c "SELECT 1 FROM pg_database WHERE datname = 'qopt'" -tA | grep -q 1 ||
      "$PGBIN/createdb" -h localhost -p "$(port_of "$c")" -U postgres qopt
  done
  echo "Databases ready. Next: npm run qopt -- db setup"
}

cmd_start() {
  require_bin
  for c in "${CLUSTERS[@]}"; do
    if "$PGBIN/pg_ctl" -D "$DATA/$c" status >/dev/null 2>&1; then
      echo "[$c] already running"
    else
      "$PGBIN/pg_ctl" -D "$DATA/$c" -l "$DATA/$c.server.log" -w start >/dev/null
      echo "[$c] started on port $(port_of "$c")"
    fi
  done
}

cmd_stop() {
  require_bin
  for c in "${CLUSTERS[@]}"; do
    "$PGBIN/pg_ctl" -D "$DATA/$c" -m fast stop >/dev/null 2>&1 && echo "[$c] stopped" || echo "[$c] not running"
  done
}

cmd_status() {
  require_bin
  for c in "${CLUSTERS[@]}"; do
    if "$PGBIN/pg_ctl" -D "$DATA/$c" status >/dev/null 2>&1; then
      echo "[$c] running on port $(port_of "$c")"
    else
      echo "[$c] stopped"
    fi
  done
}

cmd_destroy() {
  cmd_stop || true
  rm -rf "$DATA"
  echo "Removed $DATA"
}

case "${1:-}" in
  init) cmd_init ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  destroy) cmd_destroy ;;
  *) echo "usage: $0 init|start|stop|status|destroy" >&2; exit 2 ;;
esac
