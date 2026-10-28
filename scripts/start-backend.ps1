param([string]$Python = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Python) { $Python = Join-Path $projectRoot '.venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $Python)) { throw 'Python virtual environment not found. Create .venv and install backend/requirements.txt first.' }
$Python = (Resolve-Path -LiteralPath $Python).Path
$probe = [Net.Sockets.TcpClient]::new()
try {
    $pending = $probe.ConnectAsync('127.0.0.1', 8000)
    if ($pending.Wait(500) -and $probe.Connected) { throw 'Port 8000 is already in use. The backend may already be running.' }
} catch [System.AggregateException] { } finally { $probe.Dispose() }
$env:LOCAL_DEV = '1'
$env:DATA_DIR = Join-Path $projectRoot 'data'
$env:PYTHONPATH = Join-Path $projectRoot 'backend'
New-Item -ItemType Directory -Path $env:DATA_DIR -Force | Out-Null
$worker = $null
$workerRuntimeId = $null
$workerStartedAt = [DateTime]::UtcNow
try {
    $worker = Start-Process -FilePath $Python -ArgumentList @('-m','app.worker') -WorkingDirectory (Join-Path $projectRoot 'backend') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:DATA_DIR 'worker-local.stdout.log') -RedirectStandardError (Join-Path $env:DATA_DIR 'worker-local.stderr.log')
    if ($worker.WaitForExit(1500)) { throw 'Worker failed to start. Check data/worker-local.stderr.log; another worker may already be using this data directory.' }
    $workerPidFile = Join-Path $env:DATA_DIR 'worker.pid'
    if (Test-Path -LiteralPath $workerPidFile) {
        $pidFile = Get-Item -LiteralPath $workerPidFile
        $candidateId = 0
        if ($pidFile.LastWriteTimeUtc -ge $workerStartedAt -and [int]::TryParse((Get-Content -LiteralPath $workerPidFile -Raw).Trim(), [ref]$candidateId)) {
            $workerRuntimeId = $candidateId
        }
    }
    Write-Host 'Backend: http://127.0.0.1:8000 (API + worker)'
    Write-Host 'Keep this window open. Press Ctrl+C to stop.'
    Push-Location (Join-Path $projectRoot 'backend')
    try { & $Python -m uvicorn app.main:app --host 127.0.0.1 --port 8000; if ($LASTEXITCODE -ne 0) { throw "Backend exited with code $LASTEXITCODE" } } finally { Pop-Location }
} finally {
    if ($worker -and -not $worker.HasExited) {
        if ($workerRuntimeId -and $workerRuntimeId -ne $worker.Id) { Stop-Process -Id $workerRuntimeId -ErrorAction SilentlyContinue }
        Stop-Process -Id $worker.Id -ErrorAction SilentlyContinue
    }
}
