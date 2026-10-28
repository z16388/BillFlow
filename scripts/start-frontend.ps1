$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js and npm are required.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'frontend\node_modules\vite'))) { throw 'Frontend dependencies not found. Run npm install in the frontend folder first.' }
Write-Host 'Frontend: http://127.0.0.1:5173'
Write-Host 'Start the backend too. Keep this window open. Press Ctrl+C to stop.'
Push-Location (Join-Path $projectRoot 'frontend')
try { & npm.cmd run dev; if ($LASTEXITCODE -ne 0) { throw "Frontend exited with code $LASTEXITCODE" } } finally { Pop-Location }
