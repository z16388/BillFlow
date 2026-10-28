# BillFlow

[简体中文](README.md) | [English](README.en.md)

BillFlow is a personal bill workspace for importing statements, reconciling expenses and refunds, resolving duplicate records, and synchronizing to Feishu Bitable after preview and confirmation. Data is stored on your own device or server.

## Features

- Imports from JD, Meituan, WeChat Pay, Douyin and Alipay. UnionPay / 云闪付 import is planned.
- Deduplication, refund matching, net expenses, manual entries, categories and filtering rules.
- Offline OCR for Douyin order screenshots, with manual review.
- Feishu field mapping, sync preview and result verification.
- Multiple accounts with separate ledgers, recycle bin and activity history.

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

You can also run `start-backend.cmd` and `start-frontend.cmd` from the project root. Before first startup, set the administrator password above in the backend process environment.

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
export DEFAULT_ADMIN_PASSWORD='replace-with-your-own-strong-password'
bash start-backend.sh
```

Keep the backend terminal open. In another terminal, start the frontend from the project root:

```bash
bash start-frontend.sh
```

Visit http://127.0.0.1:5173. The backend script starts API and worker with the same data directory; Ctrl+C stops both. Scripts can be invoked from any working directory.

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

Open `https://your-domain`. Caddy provisions TLS, the API has no public port, and the worker processes background jobs. The API image includes OCR. Use `docker compose down` to stop.

## Usage and Feishu

1. Sign in and import platform statements. See the in-app guide for export instructions.
2. Review expenses, refunds, ambiguous records and duplicates; correct them manually where needed.
3. In ledger settings, enter your own Feishu Bitable or Wiki URL and application credentials, configure field mapping, and test the connection. Grant the app read/write access to the target table and Wiki access when using a Wiki URL.
4. Select records, inspect the sync preview and confirm synchronization. Sync writes to your Feishu table; validate against a test table first.

## Data and security

Runtime data is created under `data/` or the Docker `ledger_data` volume, including accounts, ledgers, configuration and activity history. Keep it private. Set the initial administrator password before first startup. Changing the environment later does not reset existing passwords; use account management. Local development has a placeholder fallback password, `change-me-before-use`; configure your own password.

Local credential encryption uses `data/credential.key`; Docker uses `CREDENTIAL_KEY` from `.env`. Stop API and worker before backing up the entire data directory or volume, and securely back up the key separately. Losing the key prevents decryption of saved Feishu credentials. Never commit `.env` or runtime data, or expose the development server publicly. OCR runs locally; Feishu sync sends selected bill fields to Feishu.

## AI ledger assistant

Open **AI 账本助手 → AI 配置** and enter the API base URL, API key and model name. OpenAI and compatible third-party services are supported with automatic protocol selection or an explicit Responses/Chat Completions choice; the model must support function calling. Load the available models to select an exact model ID, test the current form values, then confirm saving. Tests do not save configuration. Base URLs usually end in `/v1`; the application appends the selected endpoint. A matching full endpoint URL is also accepted. Use HTTPS for remote services; HTTP is supported for loopback services. When changing the base URL, re-enter the appropriate API key or clear the old key. API keys are encrypted per account and are never returned to the browser or included in model context. Before enabling the feature, explicitly consent to sending chat messages and the ledger fields and rules needed for queries to the configured API service.

Temporary rate limits are retried up to three times with bounded backoff and visible progress. Insufficient credit is not retried, and persistent provider limits are reported rather than bypassed. Analysis requests fetch rule schemas only when needed.

Assistant replies render Markdown headings, emphasis, lists, tables, blockquotes, code blocks and links, including existing conversation history.

The assistant can analyze Feishu records, draft updates to existing records' category/environment/description, and draft the corresponding BillFlow classification and field-mapping rules. It uses existing field options only. It cannot create or delete records, fields or options, or change amounts, dates, sync keys, credentials or account permissions.

Every write requires a detailed confirmation dialog showing the before/after values, reason and scope. Nothing is selected by default. Approve individual items and click the execution button; saying “yes” in chat does not execute anything. Drafts expire after 30 minutes. The backend rechecks old values and rejects conflicts. Uncertain writes can be reconciled through read-only verification without blindly resending them. Changes are audited.

Changing Feishu records and changing BillFlow rules are separate operations. Record changes retain per-record overrides for linked local entries, so later normal syncs preserve approved values. Rule changes affect subsequent sync previews and do not immediately rewrite historical Feishu records. Each draft supports up to 100 field changes. Conversations and approvals remain in each account's private data directory and are excluded from source publication.

## License

[MIT](LICENSE).
