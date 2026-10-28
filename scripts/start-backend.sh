#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
python="${1:-$project_root/.venv/bin/python}"
[[ -x "$python" ]] || {
    echo 'Python virtual environment not found. Create .venv and install backend/requirements.lock.txt first.' >&2
    exit 1
}
# Resolve before changing the working directory.
python="$(cd -- "$(dirname -- "$python")" && pwd)/$(basename -- "$python")"
"$python" -c 'import socket, sys; s = socket.socket(); s.settimeout(0.5); busy = s.connect_ex(("127.0.0.1", 8000)) == 0; s.close(); sys.exit("Port 8000 is already in use.") if busy else None'
export LOCAL_DEV=1
export DATA_DIR="$project_root/data"
export PYTHONPATH="$project_root/backend"
mkdir -p "$DATA_DIR"
worker_pid=''
api_pid=''
cleanup() {
    trap - EXIT INT TERM HUP
    for child in "$api_pid" "$worker_pid"; do
        if [[ -n "$child" ]]; then
            kill "$child" 2>/dev/null || true
        fi
    done
    for child in "$api_pid" "$worker_pid"; do
        if [[ -n "$child" ]]; then
            wait "$child" 2>/dev/null || true
        fi
    done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
cd "$project_root/backend"
"$python" -m app.worker >"$DATA_DIR/worker-local.stdout.log" 2>"$DATA_DIR/worker-local.stderr.log" &
worker_pid=$!
sleep 1
if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo 'Worker failed to start. Check data/worker-local.stderr.log.' >&2
    exit 1
fi
echo 'Backend: http://127.0.0.1:8000 (API + worker)'
echo 'Keep this terminal open. Press Ctrl+C to stop.'
"$python" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
api_pid=$!
# Bash 3-compatible supervision: stop both if either service exits.
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null; do
    sleep 1
done
if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo 'Worker stopped unexpectedly. Check data/worker-local.stderr.log.' >&2
    exit 1
fi
wait "$api_pid"
