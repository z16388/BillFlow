import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, money } from "./lib";
import { Button, Modal } from "./components/ui";
import {
  FileInput,
  PencilLine,
  Plus,
  Trash2,
  RotateCcw,
  RefreshCw,
  ChevronRight,
  Clock3,
  Activity as ActivityIcon,
} from "lucide-react";

const labels: Record<string, string> = {
  import_enabled: "文件导入状态",
  hidden_count: "隐藏交易数",
  restored_count: "恢复交易数",
  file_name: "账单文件",
  ignore: "已排除",
  filter_exempt: "单条取消过滤",
  douyin_duplicate_exempt: "单笔豁免月付重复排除",
  douyin_duplicate_filter: "排除抖音月付重复流水",
  automatic_exclusion: "自动排除规则",
  original_order: "对应原交易单号",
  confirmed: "确认计入消费",
  refund_cash_amount: "实际退款金额（分）",
  refund_adjustment_reason: "退款修正依据",
  refund_original_order: "核实原商品订单号",
  reset_refund_cash: "恢复流水退款金额",
  refund_to: "退款关联原单",
  merge_into: "合并至原单",
  category: "分类",
  note: "备注",
  distinct_remote: "确认为另一笔消费",
  merchant: "商户",
  description: "商品 / 描述",
  amount: "原付金额",
  refund_snapshot: "累计已退款",
  method: "支付方式",
  time: "交易时间",
  state: "状态",
  retention_days: "回收站保留天数",
  event_count: "交易数",
  file_count: "文件数",
  imported_count: "导入交易数",
  linked_manual_count: "关联手动记录数",
  deleted_at: "清除时间",
  expires_at: "到期时间",
  batch_id: "回收批次",
  platform: "来源",
  record_id: "关联飞书记录",
  url: "账本地址",
  auth_mode: "授权方式",
  negative_expense: "负数支出",
  mapping: "字段映射",
  field_rules: "字段加工规则",
  filter_rules: "过滤规则",
  display_rules: "显示规则",
};
function value(key: string, item: any): string {
  if (item === undefined || item === null || item === "") return "未设置";
  if (typeof item === "boolean") return item ? "是" : "否";
  if (key === "deleted_at" || key === "expires_at")
    return new Date(item * 1000).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  if (key === "amount" || key === "refund_snapshot") return money(item);
  if (key === "field_rules") {
    const list = Array.isArray(item) ? item : [];
    const name = (s: string) =>
      s.startsWith("field:")
        ? list.find((r: any) => r.field_id === s.slice(6))?.field_name ||
          "关联字段"
        : labels[s] ||
          (
            {
              platform: "来源平台",
              sync_description: "自定义描述",
              net: "净支出",
              id: "同步标识",
              account: "支付账户",
              transaction_type: "交易类型",
            } as Record<string, string>
          )[s] ||
          s;
    return (
      list
        .map(
          (r: any) =>
            `${r.field_name || "字段"}：${r.mode === "rules" ? r.rules.map((b: any) => `${b.name || "条件"}（${b.conditions.map((c: any) => `${name(c.source)} ${c.operator} ${c.value}`).join(b.match === "any" ? " 或 " : " 且 ")}）→ ${b.result ? b.result.sources.map(name).join(b.result.mode === "join" ? " + " : " → ") + (b.result.replacements?.length ? "（含结果替换）" : "") : b.value}`).join("；") : r.mode === "fixed" ? r.value : r.sources.map(name).join(r.mode === "join" ? r.separator : " → ")}${r.required ? "（必填）" : ""}${r.replacements?.length ? "；替换：" + r.replacements.map((p: any) => p.find + " → " + p.replace).join("、") : ""}`,
        )
        .join("\n") || "无映射"
    );
  }
  if (key === "filter_rules" || key === "display_rules")
    return (
      item
        .map(
          (r: any) =>
            `${r.name}（${r.enabled ? "启用" : "停用"}）：${r.keyword}${r.replacement ? " → " + r.replacement : ""}`,
        )
        .join("；") || "无规则"
    );
  if (typeof item === "object")
    return Object.entries(item)
      .map(([k, v]) => `${k}：${v}`)
      .join("；");
  return String(item);
}

const sections = [
  {
    key: "import",
    label: "导入记录",
    icon: FileInput,
    description: "查看每次上传的文件与解析结果。",
  },
  {
    key: "edit",
    label: "编辑记录",
    icon: PencilLine,
    description: "排除、过滤、退款关联及配置变更。",
  },
  {
    key: "create",
    label: "新增记录",
    icon: Plus,
    description: "手动添加和导入产生的新交易。",
  },
  {
    key: "delete",
    label: "删除记录",
    icon: Trash2,
    description: "移入回收站及到期自动清理。",
  },
  {
    key: "restore",
    label: "恢复记录",
    icon: RotateCcw,
    description: "从回收站恢复的交易与文件。",
  },
  {
    key: "sync",
    label: "同步结果",
    icon: RefreshCw,
    description: "飞书逐笔写入、更新与重试结果。",
  },
];
const formatTime = (text: string) =>
  new Date(text.replace(" ", "T") + "Z").toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export default function Activity({
  jobs,
  details,
  retry,
  openExpense,
  renderStatus,
  openData,
}: {
  jobs: any[];
  details: (job: any) => void;
  retry: (id: string) => void;
  openExpense: (id: string) => void;
  renderStatus: (s: string) => ReactNode;
  openData: (tab: string) => void;
}) {
  const [kind, setKind] = useState("import");
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<any>(null);
  const ops = useQuery<{ items: any[]; has_more: boolean }>({
    queryKey: ["operations", kind, page],
    queryFn: () => api(`/operations?kind=${kind}&offset=${page * 50}`),
    enabled: !["import", "sync"].includes(kind),
    refetchInterval: 3000,
  });
  const section = sections.find((s) => s.key === kind)!;
  const Icon = section.icon;
  const task = ["import", "sync"].includes(kind);
  const list = task
    ? jobs.filter((j) => j.kind === kind)
    : ops.data?.items || [];
  return (
    <section className="activity-board card">
      <nav className="activity-sections" aria-label="操作记录分类">
        {sections.map((item) => (
          <button
            key={item.key}
            className={kind === item.key ? "active" : ""}
            onClick={() => {
              setKind(item.key);
              setPage(0);
            }}
          >
            <item.icon size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="activity-intro">
        <div className={"activity-category-icon activity-tone-" + kind}>
          <Icon size={21} />
        </div>
        <div>
          <h2>{section.label}</h2>
        </div>
        <span className="activity-count">本页 {list.length} 条</span>
      </div>
      <div className="activity-feed">
        {!task && ops.isError ? (
          <div className="notice warning">读取失败，请刷新重试。</div>
        ) : !task && ops.isLoading ? (
          <div className="activity-empty">
            <Clock3 size={26} />
            <strong>正在读取操作记录…</strong>
          </div>
        ) : !list.length ? (
          <div className="activity-empty">
            <span>
              <Icon size={26} />
            </span>
            <h3>暂无{section.label}</h3>
          </div>
        ) : (
          list.map((item) => (
            <article className="activity-entry" key={item.id}>
              <div className={"activity-entry-icon activity-tone-" + kind}>
                <Icon size={17} />
              </div>
              <div className="activity-entry-content">
                <div className="activity-entry-title">
                  <strong>
                    {task
                      ? kind === "import"
                        ? `导入 ${item.files?.length || 0} 个账单文件`
                        : `同步 ${item.items?.length || 0} 笔账单`
                      : item.summary}
                  </strong>
                  {task && renderStatus(item.state)}
                </div>
                <div className="activity-entry-meta">
                  <span>
                    <Clock3 size={12} />
                    {formatTime(item.created)}
                  </span>
                  {task && kind === "import" && (
                    <span>
                      {item.files
                        ?.map((f: any) => f.result?.platform)
                        .filter(
                          (v: any, i: number, a: any[]) =>
                            v && a.indexOf(v) === i,
                        )
                        .join(" · ") || "等待解析"}
                    </span>
                  )}
                  {task && kind === "sync" && (
                    <span>
                      成功{" "}
                      {item.items?.filter((i: any) => i.state === "success")
                        .length || 0}{" "}
                      · 失败{" "}
                      {item.items?.filter((i: any) => i.state === "failed")
                        .length || 0}{" "}
                      · 待核对{" "}
                      {item.items?.filter((i: any) =>
                        ["unknown", "sending"].includes(i.state),
                      ).length || 0}
                    </span>
                  )}
                  {!task && item.event_state === "trash" && (
                    <span>账单已移入回收站</span>
                  )}
                  {!task && item.event_state === "suspended" && (
                    <span>来源文件已取消导入</span>
                  )}
                </div>
                {item.error && <p className="error-text">{item.error}</p>}
                {task && kind === "import" && (
                  <p className="activity-file-preview">
                    {item.files?.map((f: any) => f.name).join("、")}
                  </p>
                )}
              </div>
              <div className="activity-entry-actions">
                {task ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => details(item)}
                    >
                      查看详情
                      <ChevronRight size={13} />
                    </Button>
                    {item.kind === "sync" && ["partial","done"].includes(item.state) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retry(item.id)}
                      >
                        核对同步结果
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    {item.event_id && item.event_state === "active" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openExpense(item.event_id)}
                      >
                        查看账单
                      </Button>
                    )}
                    {["trash", "suspended"].includes(item.event_state) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          openData(
                            item.event_state === "suspended"
                              ? "imports"
                              : "trash",
                          )
                        }
                      >
                        数据管理
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDetail(item)}
                    >
                      操作详情
                      <ChevronRight size={13} />
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))
        )}
      </div>
      <footer className="activity-board-footer">
        <span>
          <ActivityIcon size={13} />
          仅显示当前账号的操作记录
        </span>
        {!task && (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={!page}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </Button>
            <span>第 {page + 1} 页</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!ops.data?.has_more}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </footer>
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title="操作详情"
        description={detail?.summary}
        wide
      >
        {detail && (
          <>
            <div className="operation-time">{formatTime(detail.created)}</div>
            <div className="operation-diff">
              <div className="diff-header">变更项</div>
              <div className="diff-header">修改前</div>
              <div className="diff-header">修改后</div>
              {Object.keys(labels)
                .filter(
                  (k) =>
                    JSON.stringify(detail.before?.[k]) !==
                    JSON.stringify(detail.after?.[k]),
                )
                .map((k) => (
                  <div className="diff-row" key={k}>
                    <strong>{labels[k]}</strong>
                    <span>{value(k, detail.before?.[k])}</span>
                    <span>{value(k, detail.after?.[k])}</span>
                  </div>
                ))}
            </div>
            {detail.event_id && detail.event_state === "active" && (
              <Button
                variant="outline"
                onClick={() => {
                  openExpense(detail.event_id);
                  setDetail(null);
                }}
              >
                查看账单详情
              </Button>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
