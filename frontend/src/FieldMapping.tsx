import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  Plus,
  Trash2,
  WandSparkles,
  Loader2,
} from "lucide-react";
import { api, type LedgerData } from "./lib";
import { Badge, Button, Modal } from "./components/ui";
import { DateInput } from "./components/DateInput";
import "./field-mapping.css";
import { formatFeishuDate } from "./feishuDate";
import { SourcePicker } from "./MappingSourcePicker";

export type RemoteField = {
  field_id: string;
  field_name: string;
  type: number;
  is_readonly?: boolean;
  property?: { options?: { name: string }[]; date_formatter?: string };
};
type Condition = { source: string; operator: string; value: string };
type BranchResult = {
  mode: "source" | "join";
  sources: string[];
  separator: string;
  trim: boolean;
  replacements: { find: string; replace: string }[];
  prefix: string;
  suffix: string;
};
type Branch = {
  name: string;
  match: "all" | "any";
  conditions: Condition[];
  value: string;
  result?: BranchResult | null;
};
export type FieldRule = {
  field_id: string;
  role: string;
  mode: string;
  sources: string[];
  separator: string;
  value: string;
  rules: Branch[];
  fallback: string;
  trim: boolean;
  replacements: { find: string; replace: string }[];
  required: boolean;
  date_precision?: string;
  date_format?: string;
};
const types: Record<number, string> = {
  1: "文本",
  2: "数字",
  3: "单选",
  4: "多选",
  5: "日期",
  7: "复选框",
  20: "公式",
  19: "查找引用",
  1001: "创建时间",
  1002: "修改时间",
  1003: "创建人",
  1004: "修改人",
};
const supported = [1, 2, 3, 4, 5, 7];
const sources = [
  ["merchant", "原始商户"],
  ["description", "原始商品"],
  ["sync_description", "旧版商户／商品显示结果"],
  ["category", "账单分类"],
  ["platform", "账单来源平台"],
  ["method", "支付方式"],
  ["account", "支付账户"],
  ["transaction_type", "交易类型"],
  ["time", "交易日期"],
  ["net", "净支出金额"],
  ["amount", "原付金额"],
  ["refund", "已退金额"],
  ["order_id", "交易单号"],
  ["note", "备注"],
  ["id", "同步标识"],
];
const roles = [
  ["", "自定义字段", supported],
  ["date", "交易日期（自动识别）", [5]],
  ["amount", "净支出（自动识别）", [2]],
  ["description", "消费描述（自动识别）", [1]],
  ["sync_key", "同步键（自动识别）", [1]],
  ["category", "消费分类", [1, 3, 4]],
  ["source", "消费渠道 / 来源", [1, 3, 4]],
  ["order_id", "原交易单号", [1]],
  ["original", "原付金额", [2]],
  ["refund", "已退金额", [2]],
  ["note", "备注", [1]],
] as const;
const roleSource: Record<string, string> = {
  date: "time",
  amount: "net",
  description: "description",
  sync_key: "id",
  category: "category",
  source: "platform",
  order_id: "order_id",
  original: "amount",
  refund: "refund",
  note: "note",
};
const modes: Record<string, string> = {
  source: "来源取值",
  join: "组合多个来源",
  fixed: "固定值",
  rules: "条件规则",
};
const locked = ["date", "amount", "sync_key"];
export function initialRule(field_id: string, role = ""): FieldRule {
  return {
    field_id,
    role,
    mode: "source",
    sources:
      role === "description"
        ? ["description", "merchant"]
        : role
          ? [roleSource[role]]
          : [],
    separator: " · ",
    value: "",
    rules: [],
    fallback: "empty",
    trim: true,
    replacements: [],
    required: ["date", "amount", "description", "sync_key"].includes(role),
  };
}
export function migrateMappings(
  fields: RemoteField[],
  mapping: Record<string, string>,
): FieldRule[] {
  const used = new Set<string>();
  return Object.entries(mapping || {}).flatMap(([role, name]) => {
    const f = fields.find((f) => f.field_name === name);
    if (!f || used.has(f.field_id) || !roleSource[role]) return [];
    used.add(f.field_id);
    return [
      {
        ...initialRule(f.field_id, role),
        ...(role === "description" ? { sources: ["sync_description"] } : {}),
      },
    ];
  });
}
export default function FieldMapping({
  fields,
  rules,
  onChange,
  onSave,
  negative,
  notify,
}: {
  fields: RemoteField[];
  rules: FieldRule[];
  onChange: (rules: FieldRule[]) => void;
  onSave: (rules: FieldRule[]) => Promise<void>;
  negative: boolean;
  notify: (text: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState<RemoteField | null>(null);
  const [draft, setDraft] = useState<FieldRule | null>(null);
  const [tab, setTab] = useState("basic");
  const [search, setSearch] = useState("");
  const [example, setExample] = useState("");
  const [busy, setBusy] = useState(false);
  const [branchEditor, setBranchEditor] = useState<{
    index: number;
    branch: Branch;
  } | null>(null);
  const [ruleSearch, setRuleSearch] = useState("");
  const customization = useQuery<any>({
    queryKey: ["customization"],
    queryFn: () => api("/customization"),
  });
  const data = useQuery<LedgerData>({
    queryKey: ["data"],
    queryFn: () => api("/data"),
  });
  const candidate = useMemo(
    () =>
      draft
        ? [...rules.filter((r) => r.field_id !== draft.field_id), draft]
        : rules,
    [rules, draft],
  );
  const preview = useQuery<any>({
    queryKey: ["mapping-preview", candidate, negative, example],
    queryFn: () =>
      api("/mapping/preview", {
        method: "POST",
        body: JSON.stringify({
          field_rules: candidate,
          negative_expense: negative,
          ids: example ? [example] : [],
        }),
      }),
    enabled: !!draft && tab === "preview",
    retry: false,
  });
  const options = [
    ...sources.filter(
      ([key]) =>
        key !== "sync_description" ||
        customization.data?.display_rules?.length ||
        rules.some(
          (r) =>
            r.sources.includes(key) ||
            r.rules.some((b) => b.conditions.some((c) => c.source === key)),
        ) ||
        draft?.sources.includes(key),
    ),
    ...rules
      .filter((r) => r.field_id !== editing?.field_id)
      .map((r) => [
        "field:" + r.field_id,
        "加工结果 · " +
          (fields.find((f) => f.field_id === r.field_id)?.field_name ||
            "已删除字段"),
      ]),
  ];
  const sourceName = (key: string) =>
    options.find((o) => o[0] === key)?.[1] || "未配置来源";
  const patch = (change: Partial<FieldRule>) =>
    setDraft((d) => d && { ...d, ...change });
  const edit = (field: RemoteField) => {
    const hash = "#settings?field=" + encodeURIComponent(field.field_id);
    if (location.hash !== hash) location.hash = hash;
    setEditing(field);
    setRuleSearch("");
    setDraft(
      structuredClone(
        rules.find((r) => r.field_id === field.field_id) ||
          initialRule(field.field_id),
      ),
    );
    setTab(
      rules.find((r) => r.field_id === field.field_id)?.mode === "rules"
        ? "process"
        : "basic",
    );
    setExample("");
  };
  const close = () => {
    if (location.hash.startsWith("#settings?field="))
      location.hash = "#settings";
    setBranchEditor(null);
    setEditing(null);
    setDraft(null);
  };
  useEffect(() => {
    const restore = () => {
      const id = new URLSearchParams(location.hash.split("?")[1] || "").get(
        "field",
      );
      if (!id) {
        setEditing(null);
        setDraft(null);
        setBranchEditor(null);
        return;
      }
      const f = fields.find(
        (f) =>
          f.field_id === id && supported.includes(f.type) && !f.is_readonly,
      );
      if (f && editing?.field_id !== id) edit(f);
    };
    restore();
    window.addEventListener("hashchange", restore);
    return () => window.removeEventListener("hashchange", restore);
  }, [fields, editing?.field_id]);
  const updateBranch = (_index: number, change: Partial<Branch>) =>
    setBranchEditor((e) => e && { ...e, branch: { ...e.branch, ...change } });
  function inputValue(
    value: string,
    onValue: (s: string) => void,
    label: string,
  ) {
    if (editing?.type === 3)
      return (
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onValue(e.target.value)}
        >
          <option value="">选择飞书选项</option>
          {value &&
            !editing.property?.options?.some((o) => o.name === value) && (
              <option value={value}>失效选项：{value}</option>
            )}
          {editing.property?.options?.map((o) => (
            <option value={o.name} key={o.name}>
              {o.name}
            </option>
          ))}
        </select>
      );
    if (editing?.type === 7)
      return (
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onValue(e.target.value)}
        >
          <option value="">未设置</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      );
    if (editing?.type === 5)
      return (
        <DateInput
          aria-label={label}
          type="datetime-local"
          value={value}
          onChange={(e) => onValue(e.target.value)}
        />
      );
    if (editing?.type === 4)
      return (
        <div className="mapping-option-pills">
          {editing.property?.options?.map((o) => (
            <label key={o.name}>
              <input
                type="checkbox"
                checked={value.split("、").includes(o.name)}
                onChange={(e) =>
                  onValue(
                    e.target.checked
                      ? [...value.split("、").filter(Boolean), o.name].join(
                          "、",
                        )
                      : value
                          .split("、")
                          .filter((v) => v !== o.name)
                          .join("、"),
                  )
                }
              />
              {o.name}
            </label>
          ))}
        </div>
      );
    return (
      <input
        aria-label={label}
        type={editing?.type === 2 ? "number" : "text"}
        step="any"
        maxLength={1000}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        placeholder="填写写入飞书的内容"
      />
    );
  }
  function sourceInputs() {
    return (
      <div className="mapping-sources">
        <div className="mapping-control-label">
          {draft?.mode === "join" ? "按顺序组合" : "按顺序取第一个非空值"}
        </div>
        {draft?.sources.map((key, index) => (
          <div className="mapping-source-row" key={index}>
            <span>{index + 1}</span>
            <SourcePicker
              label={`取值来源 ${index + 1}`}
              value={key}
              options={options}
              onChange={(value) =>
                patch({
                  sources: draft.sources.map((s, i) =>
                    i === index ? value : s,
                  ),
                })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`上移来源 ${index + 1}`}
              disabled={!index}
              onClick={() => {
                const next = [...draft.sources];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                patch({ sources: next });
              }}
            >
              <ArrowUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`移除来源 ${index + 1}`}
              onClick={() =>
                patch({ sources: draft.sources.filter((_, i) => i !== index) })
              }
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={draft!.sources.length >= 12}
          onClick={() => patch({ sources: [...draft!.sources, ""] })}
        >
          <Plus size={14} />
          添加数据来源
        </Button>
        {draft?.mode === "join" && (
          <label className="field">
            分隔符
            <input
              value={draft.separator}
              maxLength={30}
              onChange={(e) => patch({ separator: e.target.value })}
            />
          </label>
        )}
      </div>
    );
  }
  function resultSummary(branch: Branch) {
    const result = branch.result;
    if (!result) return branch.value || "空值";
    return (
      result.sources
        .map(sourceName)
        .join(result.mode === "join" ? " + " : " → ") +
      (result.replacements.length
        ? ` · ${result.replacements.length} 项替换`
        : "") +
      (result.prefix || result.suffix ? " · 前后缀" : "")
    );
  }
  function renderBranchEditor() {
    if (!draft || !editing || !branchEditor) return null;
    const { branch, index: i } = branchEditor;
    const result = branch.result;
    const changeResult = (change: Partial<BranchResult>) =>
      updateBranch(i, { result: { ...result!, ...change } });

    return (
      <section className="mapping-branch" key={i}>
        <div className="mapping-branch-heading">
          <span>{i + 1}</span>
          <input
            aria-label={`规则名称 ${i + 1}`}
            placeholder={`规则 ${i + 1}`}
            maxLength={100}
            value={branch.name}
            onChange={(e) => updateBranch(i, { name: e.target.value })}
          />
        </div>
        <label className="field">
          满足
          <select
            aria-label={`条件关系 ${i + 1}`}
            value={branch.match}
            onChange={(e) =>
              updateBranch(i, {
                match: e.target.value as "all" | "any",
              })
            }
          >
            <option value="all">全部条件</option>
            <option value="any">任一条件</option>
          </select>
        </label>
        {branch.conditions.map((condition, j) => (
          <div className="mapping-condition" key={j}>
            <SourcePicker
              label={`规则 ${i + 1} 条件 ${j + 1} 来源`}
              value={condition.source}
              options={options}
              onChange={(value) =>
                updateBranch(i, {
                  conditions: branch.conditions.map((c, n) =>
                    n === j ? { ...c, source: value } : c,
                  ),
                })
              }
            />
            <select
              aria-label={`规则 ${i + 1} 条件 ${j + 1} 匹配方式`}
              value={condition.operator}
              onChange={(e) =>
                updateBranch(i, {
                  conditions: branch.conditions.map((c, n) =>
                    n === j
                      ? {
                          ...c,
                          operator: e.target.value,
                        }
                      : c,
                  ),
                })
              }
            >
              {[
                ["contains", "包含"],
                ["equals", "等于"],
                ["not_contains", "不包含"],
                ["starts_with", "开头是"],
                ["ends_with", "结尾是"],
                ["empty", "为空"],
              ].map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
            {condition.operator !== "empty" && (
              <input
                aria-label={`规则 ${i + 1} 条件 ${j + 1} 内容`}
                placeholder="匹配内容"
                maxLength={300}
                value={condition.value}
                onChange={(e) =>
                  updateBranch(i, {
                    conditions: branch.conditions.map((c, n) =>
                      n === j
                        ? {
                            ...c,
                            value: e.target.value,
                          }
                        : c,
                    ),
                  })
                }
              />
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`删除规则 ${i + 1} 条件 ${j + 1}`}
              disabled={branch.conditions.length === 1}
              onClick={() =>
                updateBranch(i, {
                  conditions: branch.conditions.filter((_, n) => n !== j),
                })
              }
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={branch.conditions.length >= 10}
          onClick={() =>
            updateBranch(i, {
              conditions: [
                ...branch.conditions,
                {
                  source: "merchant",
                  operator: "contains",
                  value: "",
                },
              ],
            })
          }
        >
          <Plus size={13} />
          添加条件
        </Button>
        <section className="mapping-branch-result">
          <label className="field">
            写入结果方式
            <select
              aria-label="写入结果方式"
              value={result?.mode || "fixed"}
              onChange={(e) =>
                updateBranch(i, {
                  result:
                    e.target.value === "fixed"
                      ? undefined
                      : {
                          ...(result || {
                            sources: ["merchant"],
                            separator: " · ",
                            trim: true,
                            replacements: [],
                            prefix: "",
                            suffix: "",
                          }),
                          mode: e.target.value as "source" | "join",
                        },
                })
              }
            >
              <option value="fixed">指定内容</option>
              <option value="source">引用字段内容</option>
              {[1, 3, 4].includes(editing.type) && (
                <option value="join">组合多个字段</option>
              )}
            </select>
          </label>
          {!result ? (
            <label className="field mapping-result-label">
              写入结果
              {inputValue(
                branch.value,
                (value) => updateBranch(i, { value }),
                `规则 ${i + 1} 写入结果`,
              )}
            </label>
          ) : (
            <>
              <div className="mapping-control-label">
                {result.mode === "join"
                  ? "按顺序拼接非空内容"
                  : "按顺序取第一个非空内容"}
              </div>
              {result.sources.map((key, n) => (
                <div className="mapping-source-row" key={n}>
                  <span>{n + 1}</span>
                  <SourcePicker
                    label={`结果来源 ${n + 1}`}
                    value={key}
                    options={options}
                    onChange={(value) =>
                      changeResult({
                        sources: result.sources.map((s, k) =>
                          k === n ? value : s,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`上移结果来源 ${n + 1}`}
                    disabled={!n}
                    onClick={() => {
                      const next = [...result.sources];
                      [next[n - 1], next[n]] = [next[n], next[n - 1]];
                      changeResult({ sources: next });
                    }}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`移除结果来源 ${n + 1}`}
                    disabled={result.sources.length === 1}
                    onClick={() =>
                      changeResult({
                        sources: result.sources.filter((_, k) => k !== n),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={result.sources.length >= 12}
                onClick={() =>
                  changeResult({ sources: [...result.sources, ""] })
                }
              >
                <Plus size={13} />
                添加结果来源
              </Button>
              {result.mode === "join" && (
                <label className="field">
                  连接符
                  <input
                    aria-label="结果连接符"
                    maxLength={30}
                    value={result.separator}
                    onChange={(e) =>
                      changeResult({ separator: e.target.value })
                    }
                  />
                </label>
              )}
              {[1, 3, 4].includes(editing.type) && (
                <details
                  className="mapping-result-processing"
                  open={
                    !!(
                      result.prefix ||
                      result.suffix ||
                      result.replacements.length
                    ) || undefined
                  }
                >
                  <summary>加工引用内容（可选）</summary>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={result.trim}
                      onChange={(e) => changeResult({ trim: e.target.checked })}
                    />
                    去除首尾空格
                  </label>
                  <div className="form-grid">
                    <label className="field">
                      添加前缀
                      <input
                        aria-label="结果前缀"
                        maxLength={500}
                        value={result.prefix}
                        onChange={(e) =>
                          changeResult({ prefix: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      添加后缀
                      <input
                        aria-label="结果后缀"
                        maxLength={500}
                        value={result.suffix}
                        onChange={(e) =>
                          changeResult({ suffix: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  {result.replacements.map((replacement, n) => (
                    <div className="mapping-replacement" key={n}>
                      <input
                        aria-label={`结果替换原文 ${n + 1}`}
                        placeholder="要替换的内容"
                        maxLength={200}
                        value={replacement.find}
                        onChange={(e) =>
                          changeResult({
                            replacements: result.replacements.map((r, k) =>
                              k === n ? { ...r, find: e.target.value } : r,
                            ),
                          })
                        }
                      />
                      <span>→</span>
                      <input
                        aria-label={`结果替换为 ${n + 1}`}
                        placeholder="替换为，留空即删除"
                        maxLength={500}
                        value={replacement.replace}
                        onChange={(e) =>
                          changeResult({
                            replacements: result.replacements.map((r, k) =>
                              k === n ? { ...r, replace: e.target.value } : r,
                            ),
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除结果替换 ${n + 1}`}
                        onClick={() =>
                          changeResult({
                            replacements: result.replacements.filter(
                              (_, k) => k !== n,
                            ),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={result.replacements.length >= 20}
                    onClick={() =>
                      changeResult({
                        replacements: [
                          ...result.replacements,
                          { find: "", replace: "" },
                        ],
                      })
                    }
                  >
                    <Plus size={13} />
                    添加结果替换
                  </Button>
                </details>
              )}
              <p className="mapping-policy-note">
                可引用原始账单或其他已配置字段的加工结果。加工只作用于当前规则，原始内容保留；之后仍会应用字段层的整理规则。
              </p>
            </>
          )}
        </section>
      </section>
    );
  }
  return (
    <div className="field-mapping">
      <div className="field-mapping-toolbar">
        <span>
          {fields.length} 个飞书字段 · 已配置 {rules.length} 个
        </span>
        <input
          aria-label="查找飞书字段"
          placeholder="查找字段"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="target-field-list">
        {fields
          .filter((f) => f.field_name.includes(search))
          .map((f) => {
            const r = rules.find((r) => r.field_id === f.field_id);
            const readonly = !supported.includes(f.type) || f.is_readonly;
            return (
              <button
                type="button"
                key={f.field_id}
                className={
                  "target-field-row" + (readonly ? " is-readonly" : "")
                }
                disabled={readonly}
                onClick={() => edit(f)}
              >
                <span className="target-field-icon">
                  <Columns3 size={17} />
                </span>
                <span className="target-field-main">
                  <strong>{f.field_name}</strong>
                  <small>
                    {types[f.type] || "暂不支持的字段"}
                    {r?.role
                      ? " · " + roles.find((role) => role[0] === r.role)?.[1]
                      : ""}
                  </small>
                </span>
                <span className="target-field-summary">
                  {readonly
                    ? "由飞书维护"
                    : r
                      ? r.mode === "rules"
                        ? `${r.rules.length} 条条件规则`
                        : r.mode === "fixed"
                          ? r.value || "未设置固定值"
                          : r.sources
                              .map(sourceName)
                              .join(r.mode === "join" ? " + " : " → ")
                      : "自动填写 / 按需设置"}
                </span>
                {!readonly && (
                  <>
                    <Badge tone={r ? "blue" : "neutral"}>
                      {r ? "已自定义" : "可选配置"}
                    </Badge>
                    <ChevronRight size={15} />
                  </>
                )}
              </button>
            );
          })}
      </div>
      {rules
        .filter(
          (r) =>
            !fields.some(
              (f) =>
                f.field_id === r.field_id &&
                supported.includes(f.type) &&
                !f.is_readonly,
            ),
        )
        .map((r) => (
          <div className="mapping-invalid-field" key={r.field_id}>
            <span>一个已配置字段已删除或不再可写，请重新选择字段。</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange(rules.filter((other) => other.field_id !== r.field_id))
              }
            >
              移除失效配置
            </Button>
          </div>
        ))}
      <div className="mapping-required-summary">
        常见字段会自动识别。这里的规则仅用于按需替换，同步预览中也可直接修改。
      </div>
      {draft && (
        <div className="mapping-workspace">
          <div className="mapping-workspace-heading">
            <Button variant="outline" onClick={close}>
              返回字段列表
            </Button>
            <div>
              <h2>{editing?.field_name} · 字段配置</h2>
              <p>配置来源、条件与未匹配时的处理</p>
            </div>
            <a href="#guide">查看教程 ↗</a>
          </div>
          {draft && editing && (
            <div className="mapping-editor">
              <nav className="mapping-editor-tabs">
                {[
                  ["basic", "基础配置"],
                  ["process", "加工规则"],
                  ["preview", "结果预览"],
                ].map(([key, label]) => (
                  <button
                    className={tab === key ? "active" : ""}
                    key={key}
                    onClick={() => setTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="mapping-editor-body">
                {tab === "basic" && (
                  <>
                    <label className="field">
                      字段用途
                      <select
                        aria-label="字段用途"
                        value={draft.role}
                        onChange={(e) => {
                          const role = e.target.value;
                          patch(
                            ["date", "amount", "sync_key"].includes(role)
                              ? { ...initialRule(draft.field_id, role) }
                              : { role },
                          );
                        }}
                      >
                        {roles
                          .filter(([, , ts]) =>
                            (ts as readonly number[]).includes(editing.type),
                          )
                          .map(([key, label]) => (
                            <option
                              key={key}
                              value={key}
                              disabled={
                                !!key &&
                                rules.some(
                                  (r) =>
                                    r.field_id !== draft.field_id &&
                                    r.role === key,
                                )
                              }
                            >
                              {label}
                            </option>
                          ))}
                      </select>
                    </label>
                    {locked.includes(draft.role) ? (
                      <div className="mapping-locked">
                        <WandSparkles size={17} />
                        <div>
                          <strong>{sourceName(draft.sources[0])}</strong>
                          <small>
                            使用原始日期、退款后的净额或稳定交易标识。
                          </small>
                        </div>
                      </div>
                    ) : (
                      <>
                        <label className="field">
                          处理方式
                          <select
                            aria-label="处理方式"
                            value={draft.mode}
                            onChange={(e) => patch({ mode: e.target.value })}
                          >
                            {Object.entries(modes)
                              .filter(
                                ([k]) =>
                                  k !== "join" ||
                                  [1, 3, 4].includes(editing.type),
                              )
                              .map(([key, label]) => (
                                <option value={key} key={key}>
                                  {label}
                                </option>
                              ))}
                          </select>
                        </label>
                        {["source", "join"].includes(draft.mode) &&
                          sourceInputs()}
                        {draft.mode === "fixed" && (
                          <label className="field">
                            固定内容
                            {inputValue(
                              draft.value,
                              (value) => patch({ value }),
                              "固定内容",
                            )}
                          </label>
                        )}
                        {draft.mode === "rules" && (
                          <div className="mapping-rule-shortcut">
                            <span>按顺序匹配，使用第一条命中的结果。</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setTab("process")}
                            >
                              配置条件规则
                              <ChevronRight size={14} />
                            </Button>
                          </div>
                        )}
                        <p className="mapping-policy-note">
                          映射是可选的自动填写。未匹配时保留原始内容或留空，可在同步预览中修改本笔。
                        </p>
                      </>
                    )}
                  </>
                )}
                {tab === "process" && (
                  <>
                    {[1, 5].includes(editing.type) && (
                      <section className="mapping-date-processing">
                        <h3>日期处理</h3>
                        <label className="field">
                          时间精度
                          <select
                            aria-label="日期时间精度"
                            value={draft.date_precision || "original"}
                            onChange={(e) =>
                              patch({ date_precision: e.target.value })
                            }
                          >
                            <option value="original">保留原日期和时间</option>
                            <option value="day">只保留日期（当天零点）</option>
                            <option value="month">
                              按月份归集（当月一日零点）
                            </option>
                          </select>
                        </label>
                        {editing.type === 1 ? (
                          <label className="field">
                            日期文本格式
                            <select
                              aria-label="日期文本格式"
                              value={draft.date_format || ""}
                              onChange={(e) =>
                                patch({ date_format: e.target.value })
                              }
                            >
                              <option value="">不格式化</option>
                              {[
                                "YYYY-MM-DD",
                                "YYYY/MM/DD",
                                "YYYY年MM月DD日",
                                "YYYY-MM",
                                "YYYYMMDD",
                                "YYYY-MM-DD HH:mm:ss",
                              ].map((format) => (
                                <option key={format} value={format}>
                                  {format}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <p className="mapping-policy-note">
                            {editing.property?.date_formatter && (
                              <>
                                飞书当前日期显示格式：
                                <strong>
                                  {editing.property.date_formatter}
                                </strong>
                                （例如{" "}
                                {formatFeishuDate(
                                  Date.now(),
                                  editing.property.date_formatter,
                                )}
                                ）。
                              </>
                            )}
                            日期列写入时间戳，年月日的显示样式由飞书的「编辑字段
                            → 日期格式」控制。如需输出 2026/10/27 或
                            2026年10月27日等文字，请使用文本列，来源选「交易日期」后设置日期文本格式。
                          </p>
                        )}
                        {editing.type === 1 &&
                          (!!draft.date_format ||
                            (!!draft.date_precision &&
                              draft.date_precision !== "original")) && (
                            <div className="notice warning mapping-date-warning">
                              日期处理会应用于这个字段的所有规则结果。如果结果是商户名或商品名，请将「日期文本格式」设为「不格式化」，并将时间精度设为「保留原日期和时间」。
                            </div>
                          )}
                        <p className="mapping-policy-note">
                          按北京时间处理，仅改变本字段的写入值，保留原账单时间。来源不是有效日期时会在预览提示。
                        </p>
                      </section>
                    )}
                    {locked.includes(draft.role) ? (
                      <div className="empty-small">
                        日期可在上方调整时间精度；金额与同步标识保留专用取值。
                      </div>
                    ) : (
                      <>
                        {draft.mode === "rules" && (
                          <div className="mapping-branches">
                            <div className="mapping-rule-toolbar">
                              <input
                                aria-label="搜索条件规则"
                                placeholder="搜索规则、条件或结果"
                                value={ruleSearch}
                                onChange={(e) => setRuleSearch(e.target.value)}
                              />
                              <span>
                                {draft.rules.length} 条 · 从上到下首条命中
                              </span>{" "}
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={draft.rules.length >= 50}
                                onClick={() =>
                                  setBranchEditor({
                                    index: draft.rules.length,
                                    branch: {
                                      name: "",
                                      match: "all",
                                      conditions: [
                                        {
                                          source: "merchant",
                                          operator: "contains",
                                          value: "",
                                        },
                                      ],
                                      value: "",
                                    },
                                  })
                                }
                              >
                                <Plus size={14} />
                                添加条件规则
                              </Button>
                            </div>
                            <div className="mapping-rule-list">
                              {draft.rules
                                .map((branch, i) => ({ branch, i }))
                                .filter(({ branch }) =>
                                  [
                                    branch.name,
                                    resultSummary(branch),
                                    ...branch.conditions.map(
                                      (c) =>
                                        `${sourceName(c.source)} ${c.value}`,
                                    ),
                                  ]
                                    .join(" ")
                                    .toLowerCase()
                                    .includes(ruleSearch.toLowerCase()),
                                )
                                .map(({ branch, i }) => (
                                  <div className="mapping-rule-summary" key={i}>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setBranchEditor({
                                          index: i,
                                          branch: structuredClone(branch),
                                        })
                                      }
                                    >
                                      <span className="mapping-rule-number">
                                        {i + 1}
                                      </span>
                                      <span>
                                        <strong>
                                          {branch.name || `规则 ${i + 1}`}
                                        </strong>
                                        <small>
                                          {branch.conditions
                                            .map(
                                              (c) =>
                                                `${sourceName(c.source)} ${c.operator === "equals" ? "等于" : c.operator === "contains" ? "包含" : c.operator === "empty" ? "为空" : c.operator === "not_contains" ? "不包含" : c.operator === "starts_with" ? "开头是" : "结尾是"} ${c.value}`,
                                            )
                                            .join(
                                              branch.match === "any"
                                                ? " 或 "
                                                : " 且 ",
                                            )}
                                        </small>
                                      </span>
                                      <b title={resultSummary(branch)}>
                                        {resultSummary(branch)}
                                      </b>
                                      <ChevronRight size={15} />
                                    </button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      aria-label={`上移规则 ${i + 1}`}
                                      disabled={!i}
                                      onClick={() => {
                                        const next = [...draft.rules];
                                        [next[i - 1], next[i]] = [
                                          next[i],
                                          next[i - 1],
                                        ];
                                        patch({ rules: next });
                                      }}
                                    >
                                      <ArrowUp size={14} />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      aria-label={`下移规则 ${i + 1}`}
                                      disabled={i === draft.rules.length - 1}
                                      onClick={() => {
                                        const next = [...draft.rules];
                                        [next[i + 1], next[i]] = [
                                          next[i],
                                          next[i + 1],
                                        ];
                                        patch({ rules: next });
                                      }}
                                    >
                                      <ArrowDown size={14} />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      aria-label={`删除规则 ${i + 1}`}
                                      onClick={() =>
                                        patch({
                                          rules: draft.rules.filter(
                                            (_, n) => n !== i,
                                          ),
                                        })
                                      }
                                    >
                                      <Trash2 size={14} />
                                    </Button>
                                  </div>
                                ))}
                            </div>

                            <label className="field">
                              未匹配账单的处理
                              <select
                                aria-label="未命中时"
                                value={draft.fallback}
                                onChange={(e) =>
                                  patch({ fallback: e.target.value })
                                }
                              >
                                <option value="empty">
                                  不做替换（保留原始内容）
                                </option>
                                <option value="fixed">使用默认值</option>
                                <option value="source">使用默认来源</option>
                              </select>
                            </label>
                            <p className="mapping-policy-note">
                              没有匹配规则也可以预览。消费项目会保留原商品／商户；类型或环境没有可用选项时留空，在同步预览中补充即可。
                            </p>
                            {draft.fallback === "fixed" && (
                              <label className="field">
                                默认值
                                {inputValue(
                                  draft.value,
                                  (value) => patch({ value }),
                                  "默认值",
                                )}
                              </label>
                            )}
                            {draft.fallback === "source" && sourceInputs()}
                          </div>
                        )}
                        {[1, 3, 4].includes(editing.type) && (
                          <section className="mapping-text-processing">
                            <h3>文本整理</h3>
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={draft.trim}
                                onChange={(e) =>
                                  patch({ trim: e.target.checked })
                                }
                              />
                              去除首尾空格
                            </label>
                            {draft.replacements.map((r, i) => (
                              <div className="mapping-replacement" key={i}>
                                <input
                                  aria-label={`替换原文 ${i + 1}`}
                                  placeholder="原文"
                                  value={r.find}
                                  maxLength={200}
                                  onChange={(e) =>
                                    patch({
                                      replacements: draft.replacements.map(
                                        (r, n) =>
                                          n === i
                                            ? { ...r, find: e.target.value }
                                            : r,
                                      ),
                                    })
                                  }
                                />
                                <span>→</span>
                                <input
                                  aria-label={`替换结果 ${i + 1}`}
                                  placeholder="替换为"
                                  value={r.replace}
                                  maxLength={500}
                                  onChange={(e) =>
                                    patch({
                                      replacements: draft.replacements.map(
                                        (r, n) =>
                                          n === i
                                            ? { ...r, replace: e.target.value }
                                            : r,
                                      ),
                                    })
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`删除替换 ${i + 1}`}
                                  onClick={() =>
                                    patch({
                                      replacements: draft.replacements.filter(
                                        (_, n) => n !== i,
                                      ),
                                    })
                                  }
                                >
                                  <Trash2 size={13} />
                                </Button>
                              </div>
                            ))}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={draft.replacements.length >= 20}
                              onClick={() =>
                                patch({
                                  replacements: [
                                    ...draft.replacements,
                                    { find: "", replace: "" },
                                  ],
                                })
                              }
                            >
                              <Plus size={13} />
                              添加替换
                            </Button>
                          </section>
                        )}
                        {draft.mode !== "rules" &&
                          ![1, 3, 4].includes(editing.type) && (
                            <div className="empty-small">
                              此处理方式无需额外加工。
                            </div>
                          )}
                      </>
                    )}
                  </>
                )}
                {tab === "preview" && (
                  <div className="mapping-preview">
                    <label className="field">
                      示例账单
                      <select
                        aria-label="示例账单"
                        value={example}
                        onChange={(e) => setExample(e.target.value)}
                      >
                        <option value="">最近 5 条有效消费</option>
                        {data.data?.expenses
                          .filter(
                            (e) =>
                              !["filtered", "excluded", "refunded"].includes(
                                e.status,
                              ) && e.net > 0,
                          )
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.time.slice(0, 10)} ·{" "}
                              {e.merchant || e.description}
                            </option>
                          ))}
                      </select>
                    </label>
                    <small>
                      已过滤、已排除及全额退款不参与预览；单笔解除过滤后可参与。
                    </small>
                    {preview.isFetching ? (
                      <div className="empty-small">
                        <Loader2 className="spin" size={18} />
                        正在预览…
                      </div>
                    ) : preview.isError ? (
                      <div className="notice warning">
                        {(preview.error as Error).message}
                      </div>
                    ) : !preview.data?.items.length ? (
                      <div className="empty-small">
                        暂无符合条件的消费账单。
                      </div>
                    ) : (
                      preview.data.items.map((item: any) => (
                        <article key={item.id}>
                          <strong>{item.merchant || item.description}</strong>
                          <small>
                            {item.description} · {item.time}
                          </small>
                          <div className="mapping-preview-value">
                            {item.fields[editing.field_name] === undefined
                              ? "不写入"
                              : editing.type === 5
                                ? formatFeishuDate(
                                    item.fields[editing.field_name],
                                    editing.property?.date_formatter,
                                  )
                                : typeof item.fields[editing.field_name] ===
                                    "boolean"
                                  ? item.fields[editing.field_name]
                                    ? "是"
                                    : "否"
                                  : String(item.fields[editing.field_name])}
                          </div>
                          <small>{item.trace[editing.field_name]}</small>
                          {item.inputs && (
                            <details className="mapping-input-details">
                              <summary>查看来源值</summary>
                              {Array.from(
                                new Set([
                                  ...draft.sources,
                                  ...draft.rules.flatMap((b) => [
                                    ...b.conditions.map((c) => c.source),
                                    ...(b.result?.sources || []),
                                  ]),
                                ]),
                              ).map((key) => (
                                <p key={key}>
                                  <span>
                                    {sourceName(key)}
                                    {key === "sync_description" && (
                                      <small>
                                        {item.display_rule
                                          ? `命中：${item.display_rule}`
                                          : "未命中显示规则，使用商品／商户"}
                                      </small>
                                    )}
                                  </span>
                                  <b>
                                    {String(item.inputs[key] ?? "空值") ||
                                      "空值"}
                                  </b>
                                </p>
                              ))}
                            </details>
                          )}
                          {item.warnings.map((w: string) => (
                            <p className="mapping-preview-warning" key={w}>
                              {w}
                            </p>
                          ))}
                        </article>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="mapping-editor-footer">
                <Button
                  variant="ghost"
                  disabled={
                    busy || !rules.some((r) => r.field_id === draft.field_id)
                  }
                  onClick={async () => {
                    const next = rules.filter(
                      (r) => r.field_id !== draft.field_id,
                    );
                    setBusy(true);
                    try {
                      await onSave(next);
                      onChange(next);
                      close();
                    } catch (e) {
                      notify((e as Error).message, true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  移除自定义规则
                </Button>
                <div>
                  <Button variant="outline" onClick={close}>
                    取消
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api("/mapping/preview", {
                          method: "POST",
                          body: JSON.stringify({
                            field_rules: candidate,
                            negative_expense: negative,
                            ids: [],
                          }),
                        });
                        await onSave(candidate);
                        onChange(candidate);
                        close();
                      } catch (e) {
                        notify((e as Error).message, true);
                        setTab("preview");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? <Loader2 size={14} className="spin" /> : null}
                    保存字段配置
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <Modal
        open={!!branchEditor}
        onClose={() => setBranchEditor(null)}
        title={
          branchEditor && branchEditor.index < (draft?.rules.length || 0)
            ? "编辑条件规则"
            : "新增条件规则"
        }
        description="满足条件后写入指定结果；先命中的规则优先。"
        sheet
      >
        <div className="mapping-editor mapping-branch-editor">
          {renderBranchEditor()}
        </div>
        <div className="mapping-editor-footer">
          <Button variant="outline" onClick={() => setBranchEditor(null)}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (!branchEditor || !draft) return;
              const branch = branchEditor.branch;
              if (
                branch.conditions.some(
                  (c) => c.operator !== "empty" && !c.value.trim(),
                )
              ) {
                notify("请补齐匹配内容", true);
                return;
              }
              if (
                branch.result &&
                (branch.result.sources.some((s) => !s) ||
                  branch.result.replacements.some((r) => !r.find))
              ) {
                notify("请补齐结果来源和替换原文", true);
                return;
              }
              const next = [...draft.rules];
              next[branchEditor.index] = branch;
              patch({ rules: next });
              setRuleSearch("");
              setBranchEditor(null);
            }}
          >
            确认规则
          </Button>
        </div>
      </Modal>
    </div>
  );
}
