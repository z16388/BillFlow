# BillFlow

[简体中文](README.md) | [English](README.en.md)

A self-hosted personal bill workspace. Import statements, reconcile expenses and refunds, review duplicates, then preview and confirm synchronization to Feishu Bitable. Your data stays on your device or server until you choose to sync it.

## Features

- Imports from JD, Meituan, WeChat Pay, Douyin and Alipay. UnionPay / 云闪付 import is planned.
- Deduplication, refund matching, net expenses, manual entries, categories and filtering rules.
- Offline OCR for Douyin order screenshots, with manual review.
- Feishu field mapping, sync preview and result verification.
- Multiple accounts with separate ledgers, recycle bin and activity history.

Documentation is available in English and Simplified Chinese. The application UI currently uses Simplified Chinese. Export format changes may affect parsing; review imported results. Live Feishu writes and Linux container deployment still require deployment-specific validation.

## Windows setup

Install Git, Python 3.12 and Node.js 22 with npm. Run in PowerShell:

```powershell
git clone https://github.com/z16388/BillFlow.git
cd BillFlow
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock.txt
npm.cmd --prefix frontend ci
$env:DEFAULT_ADMIN_PASSWORD = 'replace-with-your-own-strong-password'
powershell -ExecutionPolicy Bypass -File scripts/start-backend.ps1
```

Keep this terminal open. In another PowerShell at the project root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-frontend.ps1
```

Visit http://127.0.0.1:5173 and sign in as `admin` with your configured password. The backend script starts both API and worker and stops both when closed. Screenshot OCR requires Windows Simplified Chinese language and OCR capabilities.

## Linux setup (Ubuntu / Debian)

Install Git, Python 3.12 with its venv module, and Node.js 22 with npm. Install OCR packages and start the API:

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
git clone https://github.com/z16388/BillFlow.git
cd BillFlow
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.lock.txt
npm --prefix frontend ci
export LOCAL_DEV=1
export DATA_DIR="$PWD/data"
export PYTHONPATH="$PWD/backend"
export DEFAULT_ADMIN_PASSWORD='replace-with-your-own-strong-password'
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In a second terminal at the project root:

```bash
DATA_DIR="$PWD/data" PYTHONPATH="$PWD/backend" .venv/bin/python -m app.worker
```

In a third terminal run `npm --prefix frontend run dev` and visit http://127.0.0.1:5173. API and worker must share the same data directory.

## Docker Compose (Windows / Linux)

Install Docker with Compose v2. On Windows use Docker Desktop with Linux containers. Point a domain at your server and allow TCP ports 80 and 443.

1. Clone the repository and copy `.env.example` to `.env`: `Copy-Item .env.example .env` in PowerShell or `cp .env.example .env` on Linux.
2. Set `SITE_DOMAIN` to your domain name without a URL scheme and set a strong `DEFAULT_ADMIN_PASSWORD`.
3. With Python dependencies installed, run `python scripts/create_secrets.py` and put the generated `CREDENTIAL_KEY` in `.env`. API and worker use the same key.
4. Start the stack:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker web
```

Open `https://your-domain`. Caddy provisions TLS, the API has no public port, and the worker processes background jobs. The API image includes OCR. Use `docker compose down` to stop; adding `-v` deletes data volumes.

## Usage and Feishu

Import statements and consult the in-app guide for export instructions. Review expenses, refunds, duplicates and ambiguous records. In ledger settings, enter your own Feishu Bitable or Wiki URL, application credentials and field mapping, then test the connection. Grant the app access to read and write the target table, plus Wiki access when applicable. Select records, inspect the sync preview and confirm. Validate against a test table first.

## Data and security

This repository contains no personal statements, databases, uploads, screenshots, backups, logs, real ledger links or application credentials. Test directories and development validation utilities are excluded from the published source.

Runtime data is created under `data/` or the Docker `ledger_data` volume, including accounts, ledgers, configuration and activity history. Keep it private. Set the initial administrator password before first startup. Changing the environment later does not reset existing passwords; use account management. Local development has a placeholder fallback password, `change-me-before-use`; configure your own password.

Local credential encryption uses `data/credential.key`; Docker uses `CREDENTIAL_KEY` from `.env`. Stop API and worker before backing up the entire data directory or volume, and securely back up the key separately. Losing the key prevents decryption of saved Feishu credentials. Never commit `.env` or runtime data, or expose the development server publicly. OCR runs locally; Feishu sync sends selected bill fields to Feishu.

## License

[MIT](LICENSE).
