import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  ChevronRight,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { api } from "./lib";
import { Badge, Button, Modal } from "./components/ui";
import MarkdownMessage from "./MarkdownMessage";
import "./ai-assistant.css";

type AIConfig = {
  enabled: boolean;
  base_url: string;
  api_type: "auto" | "responses" | "chat_completions";
  model: string;
  has_api_key: boolean;
  share_data: boolean;
  version: number;
};
type Item = {
  id: string;
  kind: "record" | "mapping";
  field: string;
  before: any;
  preview_before?: any;
  after: any;
  reason: string;
  status: string;
  error: string;
  scope: string;
  context: {
    description?: string;
    category?: string;
    environment?: string;
    date?: number;
    amount?: number;
  };
  record_id?: string;
};
type Plan = {
  id: string;
  status: string;
  created: number;
  expires: number;
  items: Item[];
};
type Chat = {
  id: string;
  title: string;
  busy: boolean;
  progress?: string;
  messages: { id: string; role: string; content: string }[];
  plans: Plan[];
};
const statusNames: Record<string, string> = {
  pending: "待批准",
  draft: "生成中",
  executing: "执行中",
  partial: "部分已处理",
  completed: "已完成",
  failed: "生成未完成",
  success: "已成功",
  applying: "结果待核对",
  uncertain: "结果待核对",
  conflict: "需重新生成",
};
const sourceNames: Record<string, string> = {
  merchant: "商户",
  description: "商品描述",
  sync_description: "消费描述",
  category: "原分类",
  platform: "账单来源",
  method: "支付方式",
  account: "支付账户",
  transaction_type: "交易类型",
  note: "备注",
  time: "日期",
  amount: "原付",
  net: "净支出",
  refund: "退款",
  id: "同步键",
  order_id: "订单号",
};
const operators: Record<string, string> = {
  contains: "包含",
  equals: "等于",
  not_contains: "不包含",
  starts_with: "开头是",
  ends_with: "结尾是",
  empty: "为空",
};
function valueText(v: any): string {
  return v == null || v === ""
    ? "未填写"
    : Array.isArray(v)
      ? v.join("、")
      : typeof v === "object"
        ? JSON.stringify(v, null, 2)
        : String(v);
}
function timeText(value?: number) {
  if (!value) return "日期未填写";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime())
    ? "日期无法识别"
    : date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}
function RuleValue({ rule }: { rule: any }) {
  if (!rule)
    return <span className="ai-muted">沿用原字段映射，尚无独立规则</span>;
  const sources = (rule.sources || [])
    .map((s: string) => sourceNames[s] || s)
    .join(rule.separator || "、");
  return (
    <div className="ai-rule-value">
      <strong>
        {
          (
            {
              source: "按来源取值",
              fixed: "固定值",
              join: "组合来源",
              rules: "条件规则",
            } as any
          )[rule.mode]
        }
        {rule.role
          ? ` · 用途：${({ category: "分类", source: "来源/环境", description: "描述" } as any)[rule.role] || rule.role}`
          : ""}
      </strong>
      {rule.mode === "fixed" ? (
        <p>{valueText(rule.value)}</p>
      ) : (
        sources && <p>来源：{sources}</p>
      )}
      {(rule.rules || []).map((branch: any, index: number) => (
        <div className="ai-rule-branch" key={index}>
          <b>
            {index + 1}. {branch.name || "条件"}
          </b>
          <p>
            {(branch.conditions || [])
              .map(
                (c: any) =>
                  `${sourceNames[c.source] || c.source} ${operators[c.operator] || c.operator} ${c.value || ""}`,
              )
              .join(branch.match === "any" ? "；或 " : "；且 ")}
          </p>
          <p>
            →{" "}
            {branch.result
              ? `${(branch.result.sources || []).map((s: string) => sourceNames[s] || s).join(branch.result.separator || "、")}${branch.result.prefix ? `（前缀 ${branch.result.prefix}）` : ""}${branch.result.suffix ? `（后缀 ${branch.result.suffix}）` : ""}`
              : valueText(branch.value)}
          </p>
        </div>
      ))}
      {rule.mode === "rules" && (
        <p>
          未命中时：
          {rule.fallback === "source"
            ? `使用来源 ${sources}`
            : rule.fallback === "fixed"
              ? valueText(rule.value)
              : "留空"}
        </p>
      )}
      <details>
        <summary>查看完整规则</summary>
        <pre>{JSON.stringify(rule, null, 2)}</pre>
      </details>
    </div>
  );
}

function AISettings({
  config,
  close,
  notify,
}: {
  config: AIConfig;
  close: () => void;
  notify: (s: string, error?: boolean) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    enabled: config.enabled,
    base_url: config.base_url || "https://api.openai.com/v1",
    api_type: config.api_type || "auto",
    model: config.model,
    api_key: "",
    clear_api_key: false,
    share_data: config.share_data,
    version: config.version,
  });
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const apiLabel =
    form.api_type === "auto"
      ? "自动选择"
      : form.api_type === "responses"
        ? "Responses"
        : "聊天兼容";
  const changed =
    form.enabled !== config.enabled ||
    form.base_url !== (config.base_url || "https://api.openai.com/v1") ||
    form.api_type !== (config.api_type || "auto") ||
    form.model !== config.model ||
    form.share_data !== config.share_data ||
    !!form.api_key ||
    form.clear_api_key;
  async function save() {
    setBusy(true);
    try {
      await api("/ai/settings", { method: "PUT", body: JSON.stringify(form) });
      await qc.invalidateQueries({ queryKey: ["ai-settings"] });
      notify("AI 配置已保存，API Key 不会显示在聊天中");
      close();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setTestMessage("");
    try {
      const r = await api("/ai/test", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setTestMessage(r.message);
    } catch (e) {
      setTestMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadModels() {
    setBusy(true);
    setTestMessage("");
    try {
      const result = await api("/ai/models", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setModels(result.models);
      setTestMessage(
        `已读取 ${result.models.length} 个可用模型，请从列表选择。`,
      );
    } catch (e) {
      setTestMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) close();
      }}
      title="AI 配置"
      description="连接 OpenAI 或兼容接口的第三方服务。密钥仅在后端加密保存，配置属于当前账号。"
    >
      <div className="ai-settings-form">
        <label className="field">
          API 地址
          <input
            type="url"
            value={form.base_url}
            disabled={busy}
            maxLength={1000}
            placeholder="https://api.example.com/v1"
            onChange={(e) => {
              setModels([]);
              setForm({ ...form, base_url: e.target.value });
            }}
          />
          <small>
            填写服务商提供的基础地址，通常以 /v1 结尾。接口路径会自动追加。
          </small>
        </label>
        <label className="field">
          接口格式
          <select
            value={form.api_type}
            disabled={busy}
            onChange={(e) =>
              setForm({
                ...form,
                api_type: e.target.value as AIConfig["api_type"],
              })
            }
          >
            <option value="auto">自动选择（推荐）</option>
            <option value="responses">Responses（/responses）</option>
            <option value="chat_completions">聊天兼容（多数第三方服务）</option>
          </select>
          <small>不清楚时选“自动选择”；模型需支持工具调用。</small>
        </label>
        <label className="field">
          模型名称
          <input
            value={form.model}
            disabled={busy}
            placeholder="填写你的 API 账号可用的模型名称"
            maxLength={120}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <small>填写服务商提供的准确模型名称。</small>
        </label>
        <div className="ai-actions">
          <Button
            variant="outline"
            onClick={loadModels}
            disabled={
              busy ||
              form.clear_api_key ||
              (!form.api_key && !config.has_api_key)
            }
          >
            读取可用模型
          </Button>
          {!!models.length && (
            <select
              aria-label="选择可用模型"
              disabled={busy}
              value={models.includes(form.model) ? form.model : ""}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            >
              <option value="" disabled>
                请选择服务商返回的模型
              </option>
              {models.map((model) => (
                <option value={model} key={model}>
                  {model}
                </option>
              ))}
            </select>
          )}
        </div>
        {!!models.length && !!form.model && !models.includes(form.model) && (
          <p className="error-text">
            当前模型不在服务商返回的列表中，请重新选择。
          </p>
        )}
        <label className="field">
          API Key
          <input
            type="password"
            disabled={busy}
            autoComplete="off"
            value={form.api_key}
            placeholder={
              config.has_api_key
                ? form.base_url !== config.base_url
                  ? "API 地址已变化，请重新填写对应的 Key"
                  : "已保存；留空保持原密钥"
                : "输入 API Key"
            }
            maxLength={500}
            onChange={(e) => {
              setModels([]);
              setForm({
                ...form,
                api_key: e.target.value,
                clear_api_key: false,
              });
            }}
          />
        </label>
        {config.has_api_key && (
          <label className="ai-check">
            <input
              type="checkbox"
              checked={form.clear_api_key}
              onChange={(e) =>
                setForm({
                  ...form,
                  clear_api_key: e.target.checked,
                  api_key: "",
                  enabled: e.target.checked ? false : form.enabled,
                })
              }
            />
            清除已保存的 API Key
          </label>
        )}
        <label className="ai-check">
          <input
            type="checkbox"
            checked={form.share_data}
            onChange={(e) => setForm({ ...form, share_data: e.target.checked })}
          />
          我同意将聊天内容及查询所需的账单字段、分类规则发送到上方配置的 API
          服务。
        </label>
        <label className="ai-check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          启用 AI 助手
        </label>
        <div className="ai-config-summary">
          <strong>本次将保存</strong>
          <p>
            API 地址：{form.base_url || "未填写"}；接口：
            {apiLabel}
          </p>
          <p>
            模型：{form.model || "未填写"}；功能：
            {form.enabled ? "启用" : "停用"}；数据发送：
            {form.share_data ? "允许" : "不允许"}；密钥：
            {form.clear_api_key
              ? "清除"
              : form.api_key
                ? "更新"
                : config.has_api_key
                  ? "保持原密钥"
                  : "未设置"}
          </p>
        </div>
        {testMessage && (
          <p role="status" className="ai-notice">
            {testMessage}
          </p>
        )}
        <div className="ai-actions">
          <Button
            variant="outline"
            onClick={test}
            disabled={
              busy ||
              form.clear_api_key ||
              (!form.api_key && !config.has_api_key) ||
              !form.model ||
              !form.base_url
            }
          >
            测试连接
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 size={15} className="spin" />}确认保存配置
          </Button>
        </div>
        {changed && (
          <small className="ai-muted">
            可以先测试当前填写的配置，确认连接成功后再保存。
          </small>
        )}
      </div>
    </Modal>
  );
}

export default function AIAssistant({
  notify,
  onChanged,
}: {
  notify: (s: string, error?: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const [chatId, setChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const configQ = useQuery<AIConfig>({
    queryKey: ["ai-settings"],
    queryFn: () => api("/ai/settings"),
  });
  const chatsQ = useQuery<{ id: string; title: string }[]>({
    queryKey: ["ai-chats"],
    queryFn: () => api("/ai/chats"),
  });
  const chatQ = useQuery<Chat>({
    queryKey: ["ai-chat", chatId],
    queryFn: () => api(`/ai/chats/${chatId}`),
    enabled: !!chatId,
    refetchInterval: 3000,
  });
  const chat = chatQ.data;
  const config = configQ.data;
  const busy = sending || executing || !!chat?.busy;
  const plan = chat?.plans.find((p) => p.id === planId);
  const expired = !!plan && plan.expires * 1000 < Date.now();
  const pending = plan?.items.filter((i) => i.status === "pending") || [];
  const selected = pending.filter((i) => approved[i.id]);
  const uncertain = plan?.items.some((i) =>
    ["uncertain", "applying"].includes(i.status),
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat?.messages.length, sending]);
  useEffect(() => {
    if (!chatId && chatsQ.data?.length) setChatId(chatsQ.data[0].id);
  }, [chatId, chatsQ.data]);
  function openPlan(id: string) {
    setApproved({});
    setPlanId(id);
  }
  async function newChat() {
    try {
      const r = await api("/ai/chats", {
        method: "POST",
        body: JSON.stringify({ title: "新对话" }),
      });
      setChatId(r.id);
      await qc.invalidateQueries({ queryKey: ["ai-chats"] });
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function send() {
    if (!input.trim() || busy) return;
    const content = input.trim();
    setSending(true);
    try {
      let cid = chatId;
      if (!cid) {
        const r = await api("/ai/chats", {
          method: "POST",
          body: JSON.stringify({ title: "新对话" }),
        });
        cid = r.id;
        setChatId(cid);
      }
      setInput("");
      const response = await api(`/ai/chats/${cid}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      qc.setQueryData(["ai-chat", cid], response.chat);
      await qc.invalidateQueries({ queryKey: ["ai-chats"] });
      const fresh = response.chat.plans.find(
        (p: Plan) => p.id === response.plan_id,
      );
      if (fresh?.items.length && fresh.status === "pending") openPlan(fresh.id);
      if (response.error) notify(response.error, true);
    } catch (e) {
      setInput(content);
      notify((e as Error).message, true);
      await chatQ.refetch();
    } finally {
      setSending(false);
    }
  }
  async function execute() {
    if (!plan || !selected.length || expired || executing) return;
    setExecuting(true);
    try {
      const result: Plan = await api(`/ai/plans/${plan.id}/execute`, {
        method: "POST",
        body: JSON.stringify({
          item_ids: selected.map((i) => i.id),
          confirmed: true,
        }),
      });
      setApproved({});
      await chatQ.refetch();
      await onChanged();
      notify(
        `本次执行结束，草案中已成功 ${result.items.filter((i) => i.status === "success").length} 项，请核对逐项结果`,
      );
    } catch (e) {
      notify(
        (e as Error).message + "；如出现结果待核对，请先核对，不要重复执行",
        true,
      );
      await chatQ.refetch();
    } finally {
      setExecuting(false);
    }
  }
  async function reconcile() {
    if (!plan) return;
    setExecuting(true);
    try {
      await api(`/ai/plans/${plan.id}/reconcile`, { method: "POST" });
      await chatQ.refetch();
      await onChanged();
      notify("已只读核对飞书结果，没有重发写入请求");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setExecuting(false);
    }
  }
  return (
    <div className="ai-page">
      <div className="ai-page-toolbar">
        <div className="ai-safety">
          <ShieldCheck size={18} />
          <span>查询可直接进行，所有修改先预览、逐条批准</span>
        </div>
        <Button
          variant="outline"
          onClick={() => setSettingsOpen(true)}
          disabled={!config}
        >
          <Settings2 size={15} />
          AI 配置{config?.enabled && <Badge tone="green">已启用</Badge>}
        </Button>
      </div>
      {(configQ.error || chatsQ.error || chatQ.error) && (
        <p role="alert" className="error-text">
          {(configQ.error || chatsQ.error || chatQ.error)?.message}
        </p>
      )}
      {config && !config.enabled && (
        <div className="ai-notice">
          <strong>先连接你的 AI API</strong>
          <p>
            在 AI 配置中填写 API
            Key、模型，并选择是否允许发送账单数据。配置仅属于当前登录账号。
          </p>
          <Button onClick={() => setSettingsOpen(true)}>配置 AI 助手</Button>
        </div>
      )}
      <div className="ai-workspace">
        <aside className="ai-chat-list">
          <Button variant="outline" onClick={newChat} disabled={busy}>
            <Plus size={16} />
            新对话
          </Button>
          <div className="ai-chat-list-items">
            {chatsQ.data?.map((c) => (
              <button
                key={c.id}
                className={c.id === chatId ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setChatId(c.id);
                  setPlanId(null);
                }}
              >
                <MessageSquare size={15} />
                <span>{c.title}</span>
              </button>
            ))}
          </div>
          <small>历史对话保存在当前账号的本地账本中。</small>
        </aside>
        <section className="ai-chat-panel" aria-label="AI 聊天">
          <div className="ai-chat-header">
            <div className="icon-box">
              <Bot size={20} />
            </div>
            <div>
              <h2>{chat?.title || "和账本聊一聊"}</h2>
              <p>分析飞书账本，整理分类和规则</p>
            </div>
            {config?.model && <Badge>{config.model}</Badge>}
          </div>
          <div className="ai-messages" aria-live="polite">
            {!chat?.messages.length && (
              <div className="ai-welcome">
                <Bot size={36} />
                <h3>先看看账本，再决定怎么改</h3>
                <p>
                  你可以要求分析，也可以提出一批修改。AI
                  只生成建议；确认窗口里每个改动都由你决定。
                </p>
                {[
                  "分析消费类型和消费环境的使用情况，找出重叠和不一致",
                  "查找纸巾相关账单，建议统一分类，先给我修改草案",
                  "查看当前分类字段规则，解释它们如何影响后续同步",
                ].map((text) => (
                  <button key={text} onClick={() => setInput(text)}>
                    {text}
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            )}
            {chat?.messages.map((m) => (
              <article key={m.id} className={`ai-message ai-message-${m.role}`}>
                <div className="ai-message-author">
                  {m.role === "user" ? "你" : "BillFlow AI"}
                </div>
                {m.role === "assistant" ? (
                  <MarkdownMessage content={m.content} />
                ) : (
                  <div className="ai-message-text">{m.content}</div>
                )}
              </article>
            ))}
            {(sending || chat?.busy) && (
              <div className="ai-thinking">
                <Loader2 size={17} className="spin" />
                {chat?.progress || "正在查询和整理建议，尚未执行任何修改…"}
              </div>
            )}
            {chat?.plans
              .filter((p) => p.items.length > 0)
              .map((p) => (
                <div className="ai-plan-card" key={p.id}>
                  <div>
                    <strong>修改草案 · {p.items.length} 项</strong>
                    <p>
                      飞书记录{" "}
                      {p.items.filter((i) => i.kind === "record").length} 项 ·
                      工具规则{" "}
                      {p.items.filter((i) => i.kind === "mapping").length} 项
                    </p>
                  </div>
                  <Badge tone={p.status === "completed" ? "green" : "amber"}>
                    {statusNames[p.status] || p.status}
                  </Badge>
                  <Button variant="outline" onClick={() => openPlan(p.id)}>
                    查看并逐项确认
                  </Button>
                </div>
              ))}
            <div ref={bottom} />
          </div>
          <form
            className="ai-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="发送给 AI 的消息"
              placeholder="例如：分析本月分类；把纸巾相关记录改为已有的日用品分类，先列出草案…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={6000}
              rows={3}
              disabled={busy || !config?.enabled}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div>
              <small>Ctrl + Enter 发送 · 仅已批准条目可以写入</small>
              <Button
                type="submit"
                disabled={!input.trim() || busy || !config?.enabled}
              >
                {busy ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Send size={16} />
                )}
                发送
              </Button>
            </div>
          </form>
        </section>
      </div>
      {settingsOpen && config && (
        <AISettings
          config={config}
          close={() => setSettingsOpen(false)}
          notify={notify}
        />
      )}
      <Modal
        open={!!plan}
        onClose={() => {
          if (!executing) setPlanId(null);
        }}
        title="逐项确认修改"
        description="勾选表示批准该项。只有点击底部执行按钮后才会写入。未勾选项保持不变。"
        wide
      >
        {plan && (
          <div className="ai-approval">
            <div className="ai-approval-top">
              <Badge tone="amber">共 {plan.items.length} 项</Badge>
              <span>
                已批准 {selected.length} 项 · 待批准 {pending.length} 项
              </span>
              <span>
                {expired
                  ? "草案已过期，请重新生成"
                  : `有效至 ${new Date(plan.expires * 1000).toLocaleTimeString("zh-CN")}`}
              </span>
            </div>
            {plan.status === "failed" && (
              <p role="alert" className="ai-notice">
                这次生成未完成，草案不能执行，请重新提出请求。
              </p>
            )}
            {plan.items.map((item, index) => (
              <section
                key={item.id}
                className={`ai-approval-item ${approved[item.id] ? "approved" : ""}`}
              >
                <header>
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={!!approved[item.id]}
                      disabled={
                        item.status !== "pending" ||
                        expired ||
                        executing ||
                        !["pending", "partial"].includes(plan.status)
                      }
                      onChange={(e) =>
                        setApproved({
                          ...approved,
                          [item.id]: e.target.checked,
                        })
                      }
                    />
                    <strong>
                      {index + 1}.{" "}
                      {item.kind === "record"
                        ? "修改飞书记录"
                        : "修改 BillFlow 规则"}{" "}
                      · {item.field}
                    </strong>
                  </label>
                  <Badge
                    tone={
                      item.status === "success"
                        ? "green"
                        : item.status === "pending"
                          ? "neutral"
                          : "amber"
                    }
                  >
                    {statusNames[item.status] || item.status}
                  </Badge>
                </header>
                {item.kind === "record" && (
                  <div className="ai-item-context">
                    <strong>{item.context.description || "未命名消费"}</strong>
                    <span>
                      {timeText(item.context.date)} · 金额{" "}
                      {valueText(item.context.amount)}
                    </span>
                    <small>记录：{item.record_id}</small>
                  </div>
                )}
                <div className="ai-diff">
                  <div>
                    <span className="ai-diff-label">修改前</span>
                    {item.kind === "mapping" ? (
                      <RuleValue rule={item.preview_before ?? item.before} />
                    ) : (
                      <p>{valueText(item.before)}</p>
                    )}
                  </div>
                  <div>
                    <span className="ai-diff-label">修改后</span>
                    {item.kind === "mapping" ? (
                      <RuleValue rule={item.after} />
                    ) : (
                      <p>{valueText(item.after)}</p>
                    )}
                  </div>
                </div>
                <p className="ai-item-reason">
                  <strong>理由：</strong>
                  {item.reason || "未提供，请核对后决定是否批准"}
                </p>
                <p className="ai-item-scope">
                  <strong>影响范围：</strong>
                  {item.scope}
                </p>
                {item.error && (
                  <p role="alert" className="error-text">
                    {item.error}
                  </p>
                )}
              </section>
            ))}
            <div className="ai-approval-footer">
              <div>
                <strong>仅执行你勾选的 {selected.length} 项</strong>
                <small>
                  执行前会重新核对旧值。冲突项不覆盖；写入超时后需核对结果。
                </small>
              </div>
              <div className="ai-actions">
                {uncertain && (
                  <Button
                    variant="outline"
                    disabled={executing}
                    onClick={reconcile}
                  >
                    只读核对结果
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={executing}
                  onClick={() => setPlanId(null)}
                >
                  暂不修改
                </Button>
                <Button
                  disabled={
                    !selected.length ||
                    expired ||
                    executing ||
                    !["pending", "partial"].includes(plan.status)
                  }
                  onClick={execute}
                >
                  {executing ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  确认执行已批准项
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
