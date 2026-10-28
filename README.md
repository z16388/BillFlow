# BillFlow

[简体中文](README.md) | [English](README.en.md)

BillFlow 是一个个人账单工作台，支持：导入账单、核对消费与退款、处理重复记录，再经预览确认同步到飞书多维表格。数据保存在你自己的设备或服务器。

## 功能

- 导入京东、美团、微信、抖音和支付宝账单；云闪付账单支持计划中。
- 消费去重、退款关联、净支出计算、手动记账、分类与过滤规则。
- 抖音订单截图离线 OCR，人工核对后补充商户和商品。
- 飞书账本配置、字段映射、同步预览与结果核对。
- 多账号、独立账本、回收站、操作记录。

## Windows 本地部署

安装 Git、Python 3.12、Node.js 22（含 npm）。在 PowerShell 执行：

```powershell
git clone https://github.com/z16388/BillFlow.git
cd BillFlow
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock.txt
npm.cmd --prefix frontend ci
$env:DEFAULT_ADMIN_PASSWORD = 'replace-with-your-own-strong-password'
powershell -ExecutionPolicy Bypass -File scripts/start-backend.ps1
```

保持后端窗口开启，在项目根目录打开另一个 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-frontend.ps1
```

也可在项目根目录运行 `start-backend.cmd` 和 `start-frontend.cmd` 启动两端；首次启动前请在后端进程的环境中设置上述管理员密码。

打开 http://127.0.0.1:5173 ，以 `admin` 和设置的密码登录。启动脚本同时运行 API 与后台 worker，关闭后端窗口会停止两者。Windows 截图 OCR 需要安装系统简体中文语言和文字识别功能。

## Linux 本地部署（Ubuntu / Debian）

安装 Git、Python 3.12 及其 venv 模块、Node.js 22 和 npm。OCR 另需：

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

保持后端终端开启，在另一个终端从项目根目录启动前端：

```bash
bash start-frontend.sh
```

访问 http://127.0.0.1:5173。后端脚本同时启动 API 和 worker，并使用同一数据目录；按 Ctrl+C 会停止两者。脚本可从任意工作目录调用。

## Docker Compose 部署（Windows / Linux）

安装支持 Compose v2 的 Docker；Windows 使用 Docker Desktop 的 Linux 容器。准备可解析到服务器的域名，开放 TCP 80 和 443。

1. 克隆仓库，在根目录将 `.env.example` 复制为 `.env`（PowerShell：`Copy-Item .env.example .env`；Linux：`cp .env.example .env`）。
2. 填入 `SITE_DOMAIN`（仅域名）和强密码 `DEFAULT_ADMIN_PASSWORD`。
3. 在已安装 Python 依赖的环境运行 `python scripts/create_secrets.py`，将生成的 `CREDENTIAL_KEY` 写入 `.env`。API 与 worker 共用该密钥。
4. 执行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker web
```

访问 `https://你的域名`。Caddy 自动申请 TLS 证书，API 不直接暴露端口，后台 worker 负责处理任务。OCR 已包含在 API 镜像。停止服务使用 `docker compose down`。

## 使用与飞书配置

1. 登录后导入平台账单，在应用内“使用教程”查看导出方式。
2. 检查消费、退款、待确认和重复记录，必要时人工修正。
3. 在“账本设置”填写自己的飞书多维表格或 Wiki 链接、应用凭证，配置字段映射并检测连接。应用需要对应表格的读写权限及 Wiki 访问权限（使用 Wiki 时）。
4. 选择记录，检查同步预览，再确认同步。同步会写入你的飞书，请先使用测试表格验证。

## 数据与安全

运行时会创建 `data/`（容器中为 `ledger_data` 卷），包含账号、独立账本、配置和操作记录，务必保持私有。首次启动前设置管理员密码；后续修改环境变量不会重置已有账号密码，请在“账号管理”修改。仅本机开发模式存在占位默认密码 `change-me-before-use`，不要依赖它部署。

本地凭证密钥自动保存在 `data/credential.key`；容器使用 `.env` 的 `CREDENTIAL_KEY`。备份时停止 API 和 worker，备份完整数据目录或卷，并单独安全保存密钥；丢失密钥将无法解密已保存的飞书凭证。不要提交 `.env` 或数据目录，不要把开发服务器直接暴露到公网。OCR 在本机执行；飞书同步会发送所选账单字段到飞书。

## AI 账本助手

在左侧“AI 账本助手 → AI 配置”填写 API 基础地址、API Key 和模型名称。支持 OpenAI 官方及第三方兼容接口，默认自动选择接口格式，也可手动指定 Responses 或聊天兼容格式，模型需支持工具调用。先点击“读取可用模型”选择服务商返回的准确名称，再“测试连接”，成功后确认保存；测试会使用当前填写内容，不会自动保存配置。地址通常以 `/v1` 结尾，程序自动追加对应接口路径；也接受与所选格式一致的完整接口地址。远程地址使用 HTTPS，本机接口可使用 HTTP。更换地址时需重新填写对应的 Key 或清除旧 Key。密钥按登录账号加密保存在本地，不返回给浏览器或发送给模型。启用前需明确同意向所配置的 API 服务发送聊天内容及查询所需的账单字段和规则。

遇到临时限流会在同一服务内进行最多3次退避重试，并显示等待状态；额度不足不会自动重试，持续的上游限流会明确提示，不会绕过服务商限制。统计查询按需读取字段信息，避免重复发送完整规则说明。

聊天回复支持 Markdown 标题、加粗、列表、表格、引用、代码块与链接，已有历史回复也会自动渲染。

支持查询统计飞书账本、为已有记录的消费类型/消费环境/描述生成修改草案，以及为 BillFlow 的对应字段生成分类和映射规则草案。仅支持现有飞书选项，不创建或删除记录、字段和选项，不修改金额、日期、同步键、凭证或账号权限。

所有修改都会弹出详细确认窗口，展示原值、新值、理由和影响范围。默认不勾选，逐项批准后点击“确认执行已批准项”才会写入；聊天中的“同意”不会执行修改。草案30分钟过期，执行前重新核对旧值，冲突项不覆盖。超时或中断后的条目可用“只读核对结果”确认，不盲目重复写入。操作记录保留修改前后内容。

修改飞书历史记录与修改工具规则是两种独立操作。前者会为已关联的本地账单保存单笔同步覆盖值；后者只影响后续同步预览，不立即改写飞书历史记录。每批最多100个字段修改。会话和审批状态按账号隔离保存在本地数据目录，不随源码发布。

## 许可证

[MIT](LICENSE)。
