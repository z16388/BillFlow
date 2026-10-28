import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { api, type Event, type Expense, type LedgerData } from "./lib";
import { Badge, Button } from "./components/ui";
import { SOURCES } from "./components/SharedFilters";

type Rule = {
  id: string;
  name: string;
  platform: string;
  field: string;
  operator: string;
  keyword: string;
  enabled: boolean;
  replacement?: string;
};
type Rules = {
  version: number;
  filter_rules: Rule[];
  display_rules: Rule[];
  douyin_duplicate_filter: boolean;
};
type Section = "filter_rules";
const fields = [
  ["any", "全部交易信息"],
  ["transaction_type", "交易类型 / 分类"],
  ["merchant", "商户"],
  ["description", "商品"],
  ["category", "分类"],
  ["method", "支付方式"],
];
function matches(event: Event, rule: Rule) {
  if (
    !rule.enabled ||
    !rule.keyword.trim() ||
    !["全部", event.platform].includes(rule.platform)
  )
    return false;
  const values =
    rule.field === "any"
      ? [
          event.transaction_type,
          event.category,
          event.merchant,
          event.description,
        ]
      : [(event as any)[rule.field]];
  return values.some((v) =>
    rule.operator === "equals"
      ? String(v || "")
          .trim()
          .toLocaleLowerCase() === rule.keyword.trim().toLocaleLowerCase()
      : String(v || "")
          .toLocaleLowerCase()
          .includes(rule.keyword.trim().toLocaleLowerCase()),
  );
}
function matchedMember(expense: Expense, rule: Rule) {
  return expense.members.find((e) => matches(e, rule));
}
export default function Customization({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const qc = useQueryClient();
  const query = useQuery<Rules>({
    queryKey: ["customization"],
    queryFn: () => api("/customization"),
  });
  const ledger = useQuery<LedgerData>({
    queryKey: ["data"],
    queryFn: () => api("/data"),
  });
  const [form, setForm] = useState<Rules | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (query.data && !dirty) setForm(structuredClone(query.data));
  }, [query.data, dirty]);
  function update(section: Section, id: string, patch: Partial<Rule>) {
    setDirty(true);
    setForm(
      (f) =>
        f && {
          ...f,
          [section]: f[section].map((r) =>
            r.id === id ? { ...r, ...patch } : r,
          ),
        },
    );
  }
  function add(section: Section) {
    setDirty(true);
    setForm(
      (f) =>
        f && {
          ...f,
          [section]: [
            ...f[section],
            {
              id: crypto.randomUUID(),
              name: "新过滤规则",
              platform: "全部",
              field: "merchant",
              operator: "contains",
              keyword: "",
              enabled: true,
            },
          ],
        },
    );
  }
  function remove(section: Section, id: string) {
    setDirty(true);
    setForm(
      (f) => f && { ...f, [section]: f[section].filter((r) => r.id !== id) },
    );
  }
  async function save() {
    if (!form) return;
    if (
      [...form.filter_rules, ...form.display_rules].some(
        (r) => !r.name.trim() || !r.keyword.trim(),
      ) ||
      form.display_rules.some((r) => !r.replacement?.trim())
    ) {
      notify("请补齐规则名称、关键词和显示内容", true);
      return;
    }
    setSaving(true);
    try {
      const result = await api<Rules>("/customization", {
        method: "PUT",
        body: JSON.stringify(form),
      });
      qc.setQueryData(["customization"], result);
      setForm(structuredClone(result));
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["data"] });
      notify("规则已保存，已应用到现有账单和后续导入");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }
  if (query.isError)
    return (
      <div className="notice warning">
        无法读取账单自定义配置。
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          重试
        </Button>
      </div>
    );
  if (!form)
    return (
      <div className="empty-small">
        <Loader2 className="spin" size={20} />
        正在读取规则…
      </div>
    );
  return (
    <div className="customization-page">
      <div className="customization-intro">
        <div>
          <span className="muted">账单过滤规则</span>
        </div>
        <div className="customization-save">
          <span>{dirty ? "有未保存的修改" : "所有修改已保存"}</span>
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Save size={15} />
            )}
            保存规则
          </Button>
        </div>
      </div>
      <div className="notice small">
        消费项目简称、消费类型和环境统一在{" "}
        <a href="#settings">账本设置 → 字段映射</a> 中配置。
      </div>
      {!!form.display_rules.length && (
        <div className="notice small">
          <span>
            保留 {form.display_rules.length}{" "}
            条旧版显示规则；字段映射仍可引用旧版显示结果。
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (
                window.confirm(
                  "停用旧版显示规则？引用它的字段会回退为原始商品／商户。请先在字段映射中配置替代规则。",
                )
              ) {
                setForm({ ...form, display_rules: [] });
                setDirty(true);
              }
            }}
          >
            停用旧版显示规则
          </Button>
        </div>
      )}
      <section className="card rules-section">
        <div className="section-head">
          <span className="icon-box">
            <Filter size={20} />
          </span>
          <div>
            <h2>抖音月付重复流水</h2>
            <p>保留原消费，排除后续重复支出。</p>
          </div>
          <Badge tone={form.douyin_duplicate_filter ? "blue" : "neutral"}>
            {form.douyin_duplicate_filter ? "已启用" : "已关闭"}
          </Badge>
        </div>
        <article className="rule-card">
          <div className="rule-heading">
            <label className="checkbox-label">
              <input
                type="checkbox"
                aria-label="启用抖音月付重复流水排除"
                checked={!!form.douyin_duplicate_filter}
                onChange={(e) => {
                  setForm({
                    ...form,
                    douyin_duplicate_filter: e.target.checked,
                  });
                  setDirty(true);
                }}
              />
              排除 ONP / INP 后续重复支出
            </label>
            <Badge>
              符合条件{" "}
              {
                (ledger.data?.expenses || []).filter(
                  (e) =>
                    e.douyin_duplicate?.certain &&
                    !e.douyin_duplicate_exempt &&
                    !e.members.some(
                      (m) => m.id === e.douyin_duplicate?.original_id,
                    ),
                ).length
              }{" "}
              笔
            </Badge>
          </div>
          <p className="muted">
            退款保留；匹配多笔原消费时留待核对。保存后同时应用于现有账单和后续导入，关闭即可恢复。
          </p>
          <details>
            <summary>判断依据</summary>
            <p className="muted">
              仅处理抖音月付的支出：商家单号以 ONP 或 INP 开头，且能唯一对应到
              31
              天内同账号、同商户、同金额、交易单号尾四位一致的前序消费。前缀本身不代表重复；详情保留原流水和匹配依据，允许单笔恢复。
            </p>
          </details>
        </article>
      </section>
      {(["filter_rules"] as Section[]).map((section) => (
        <section className="card rules-section" key={section}>
          <div className="section-head">
            <span className="icon-box">
              <Filter size={20} />
            </span>
            <div>
              <h2>账单过滤</h2>
              <p>命中任一规则即过滤。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => add(section)}
              disabled={form[section].length >= 50}
            >
              <Plus size={14} />
              添加规则
            </Button>
          </div>
          {!form[section].length && (
            <div className="empty-small">
              还没有过滤 规则，点击「添加规则」开始设置。
            </div>
          )}
          {form[section].map((rule, index) => {
            const affected = (ledger.data?.expenses || []).filter((e) =>
              matchedMember(e, rule),
            );
            return (
              <article
                className={
                  "rule-card " + (!rule.enabled ? "rule-disabled" : "")
                }
                key={rule.id}
              >
                <div className="rule-heading">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) =>
                        update(section, rule.id, { enabled: e.target.checked })
                      }
                      aria-label={`启用${rule.name}`}
                    />
                    <span>启用</span>
                  </label>
                  <input
                    className="rule-name"
                    aria-label={`规则名称 ${index + 1} ${section}`}
                    value={rule.name}
                    maxLength={80}
                    onChange={(e) =>
                      update(section, rule.id, { name: e.target.value })
                    }
                  />
                  <Badge tone={rule.enabled ? "blue" : "neutral"}>
                    {rule.enabled ? `匹配 ${affected.length} 笔` : "已关闭"}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除${rule.name}`}
                    onClick={() => remove(section, rule.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
                <div className="rule-inputs">
                  <label className="field">
                    来源
                    <select
                      value={rule.platform}
                      onChange={(e) =>
                        update(section, rule.id, { platform: e.target.value })
                      }
                    >
                      {["全部", ...SOURCES].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    匹配字段
                    <select
                      value={rule.field}
                      onChange={(e) =>
                        update(section, rule.id, { field: e.target.value })
                      }
                    >
                      {fields.map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    匹配方式
                    <select
                      value={rule.operator}
                      onChange={(e) =>
                        update(section, rule.id, { operator: e.target.value })
                      }
                    >
                      <option value="contains">包含</option>
                      <option value="equals">完全等于</option>
                    </select>
                  </label>
                  <label className="field">
                    关键词
                    <input
                      value={rule.keyword}
                      maxLength={200}
                      placeholder="输入商户、商品或交易类型"
                      onChange={(e) =>
                        update(section, rule.id, { keyword: e.target.value })
                      }
                    />
                  </label>
                </div>
              </article>
            );
          })}
        </section>
      ))}
      <a className="quiet-help-link" href="#guide">
        规则说明与使用帮助 ↗
      </a>
    </div>
  );
}
