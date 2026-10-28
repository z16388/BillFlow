import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api } from "./lib";
import { Badge, Button } from "./components/ui";
import DataRetention from "./DataRetention";
import FieldMapping, { migrateMappings } from "./FieldMapping";
export default function Settings({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["ledger"],
    queryFn: () => api("/ledger"),
  });
  const [form, setForm] = useState<any>({
    url: "",
    app_id: "",
    app_secret: "",
    auth_mode: "app",
    user_token: "",
    mapping: {},
    field_rules: null,
    negative_expense: false,
  });
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [fields, setFields] = useState<any[]>([]);
  useEffect(() => {
    if (data) {
      setForm({
        app_id: "",
        auth_mode: "app",
        negative_expense: false,
        ...data,
        url:
          data.url ||
          "",
        mapping: data.mapping || {},
        field_rules:
          data.field_rules ||
          migrateMappings(data.fields || [], data.mapping || {}),
        app_secret: "",
        user_token: "",
      });
      setFields(data.fields || []);
    }
  }, [data]);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function saveMapping(nextRules?: any[]) {
    if (
      form.url !== data?.url ||
      form.app_id !== (data?.app_id || "") ||
      form.auth_mode !== (data?.auth_mode || "app") ||
      form.app_secret ||
      form.user_token
    ) {
      if (nextRules)
        throw new Error("连接配置有未保存修改，请先保存并检测连接");
      notify("连接配置有未保存修改，请先保存并检测连接", true);
      return;
    }
    setBusy(true);
    try {
      const result = await api("/ledger/mapping", {
        method: "PUT",
        body: JSON.stringify({
          field_rules:
            nextRules ||
            form.field_rules ||
            migrateMappings(fields, form.mapping),
          negative_expense: form.negative_expense,
          version: form.version,
        }),
      });
      qc.setQueryData(["ledger"], result);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["data"] }),
        qc.invalidateQueries({ queryKey: ["operations"] }),
      ]);
      notify("字段映射已保存");
    } catch (e) {
      if (nextRules) throw e;
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setCheckError("");
    try {
      const saved = await api("/ledger", {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setForm((f: any) => ({ ...f, version: saved.version }));
      const result = await api("/ledger/check", { method: "POST" });
      setFields(result.fields);
      notify(
        `读取检测通过，已核对全表 ${result.read_count} 条记录。写入权限待实际同步验证。`,
      );
      await qc.invalidateQueries({ queryKey: ["ledger"] });
      await qc.invalidateQueries({ queryKey: ["data"] });
    } catch (e) {
      setCheckError((e as Error).message);
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-layout">
      <div className="settings-main">
        <div className="feishu-settings-group">
          <section className="card settings-card connection-settings-card">
            <div className="section-head">
              <span className="icon-box">
                <Link2 size={20} />
              </span>
              <div>
                <h2>连接飞书账本</h2>
                <p>支持个人账号的 Wiki 与 Base 多维表格链接</p>
              </div>
              {data?.checked_at && <Badge tone="green">读取已验证</Badge>}
            </div>
            <label className="field">
              账本地址
              <input
                placeholder="https://my.feishu.cn/wiki/…?table=tbl…"
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
              />
              <small>粘贴包含 table 参数的完整地址。</small>
            </label>
            <label className="field">
              访问方式
              <select
                value={form.auth_mode}
                onChange={(e) => set("auth_mode", e.target.value)}
              >
                <option value="app">自用应用身份</option>
                <option value="user_token">
                  用户令牌（临时诊断，需手动更新）
                </option>
              </select>
            </label>
            {form.auth_mode === "app" ? (
              <div className="form-grid">
                <label className="field">
                  App ID
                  <input
                    placeholder="cli_…"
                    value={form.app_id}
                    onChange={(e) => set("app_id", e.target.value)}
                  />
                </label>
                <label className="field">
                  App Secret
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      data?.has_app_secret
                        ? "已保存；留空保留原凭证"
                        : "输入应用密钥"
                    }
                    value={form.app_secret}
                    onChange={(e) => set("app_secret", e.target.value)}
                  />
                </label>
              </div>
            ) : (
              <label className="field">
                User access token
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    data?.has_user_token
                      ? "已保存；留空保留"
                      : "输入用户访问令牌"
                  }
                  value={form.user_token}
                  onChange={(e) => set("user_token", e.target.value)}
                />
                <small>
                  仅用于确认个人账本能否访问；令牌有效期有限，尚未提供 OAuth
                  自动刷新。
                </small>
              </label>
            )}
            <div className="secure-note">
              <LockKeyhole size={14} />
              密钥加密保存在服务器，不会在配置读取中返回。
            </div>
          </section>
          <section className="card settings-card mapping-settings-card">
            <div className="section-head">
              <span className="icon-box">
                <RefreshCw size={20} />
              </span>
              <div>
                <h2>字段映射</h2>
                <p>选择飞书字段，配置来源与加工规则</p>
              </div>
              {!!fields.length && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => saveMapping()}
                >
                  保存映射
                </Button>
              )}
            </div>
            {fields.length ? (
              <FieldMapping
                fields={fields}
                rules={
                  form.field_rules || migrateMappings(fields, form.mapping)
                }
                onChange={(rules) => set("field_rules", rules)}
                onSave={saveMapping}
                negative={form.negative_expense}
                notify={notify}
              />
            ) : (
              <div className="empty-small">
                先填入凭证并点击「保存账本配置并检测」，读取字段后再完成映射。
              </div>
            )}
            <div className="notice small">
              同步预览会自动识别常见字段，映射规则按需配置。
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.negative_expense}
                onChange={(e) => set("negative_expense", e.target.checked)}
              />
              我的账本用负数表示支出
            </label>
          </section>
          {checkError && (
            <div className="settings-check-error" role="alert">
              <h3>连接未成功</h3>
              <p>{checkError}</p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(checkError);
                      notify("错误信息已复制");
                    } catch {
                      notify("请选中上方文字复制", true);
                    }
                  }}
                >
                  复制错误信息
                </Button>
                <a href="#guide">查看授权教程 ↗</a>
              </div>
            </div>
          )}
          <div className="settings-actions">
            <p>
              {data?.checked_at
                ? `上次读取 ${new Date(data.checked_at).toLocaleString("zh-CN")}`
                : "尚未连接真实飞书账本"}
            </p>
            <Button onClick={save} disabled={busy}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <CheckCircle2 size={16} />
              )}
              保存账本配置并检测
            </Button>
          </div>
        </div>
        <DataRetention notify={notify} />
      </div>
      <aside className="settings-aside">
        <ShieldCheck size={29} />
        <h3>个人账号也可以使用</h3>
        <p>创建自用应用，并为自己的账本授权。</p>
        <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
          打开飞书开放平台 <ExternalLink size={14} />
        </a>
        <hr />
        <h4>连接不成功？</h4>
        <a href="#guide">查看授权教程 ↗</a>
      </aside>
    </div>
  );
}
