#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v npm >/dev/null 2>&1 || { echo 'Node.js and npm are required.' >&2; exit 1; }
[[ -d "$project_root/frontend/node_modules/vite" ]] || {
    echo 'Frontend dependencies not found. Run npm --prefix frontend ci first.' >&2
    exit 1
}
echo 'Frontend: http://127.0.0.1:5173'
echo 'Start the backend too. Keep this terminal open. Press Ctrl+C to stop.'
cd "$project_root/frontend"
exec npm run dev
