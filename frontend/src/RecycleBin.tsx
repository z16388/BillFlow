import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  FileSpreadsheet,
  ReceiptText,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api, money } from "./lib";
import { Badge, Button, Modal } from "./components/ui";

type Entry = {
  id: string;
  name?: string;
  merchant?: string;
  description?: string;
  amount?: number;
  time?: string;
  platform: string;
  category?: string;
  kind?: string;
  order_id?: string;
  method?: string;
  account?: string;
  note?: string;
  file_name?: string;
  row_count?: number;
  batch_id: string;
  deleted_at: number;
  expires_at: number;
  batch: { event_count: number; file_count: number };
};
const stamp = (n: number) =>
  new Date(n * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
const date = (n: number) =>
  new Date(n * 1000).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
const title = (e: Entry) =>
  e.name || e.merchant || e.description || "未命名账单";
export default function RecycleBin({
  notify,
  onChanged,
  taskBusy,
}: {
  notify: (s: string, error?: boolean) => void;
  onChanged: () => Promise<void>;
  taskBusy: boolean;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState("bills");
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Entry | null>(null);
  const [restoring, setRestoring] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useQuery<{
    items: Entry[];
    counts: { bills: number; files: number };
    has_more: boolean;
  }>({
    queryKey: ["trash-entries", kind, offset],
    queryFn: () => api(`/trash-entries?kind=${kind}&offset=${offset}`),
    refetchInterval: 15000,
  });
  return (
    <div className="recycle-bin">
      <div className="recycle-toolbar">
        <div className="segmented-control" aria-label="回收站分类">
          {[
            ["bills", "账单", ReceiptText],
            ["files", "文件", FileSpreadsheet],
          ].map(([key, label, Icon]: any) => (
            <button
              key={key}
              aria-pressed={kind === key}
              className={kind === key ? "active" : ""}
              onClick={() => {
                setKind(key);
                setOffset(0);
              }}
            >
              <Icon size={15} />
              {label}
              <span>{query.data?.counts[key as "bills" | "files"] ?? "—"}</span>
            </button>
          ))}
        </div>
        <span className="recycle-hint">到期自动清理</span>
      </div>
      {query.isError ? (
        <div className="notice warning">回收站读取失败，请刷新重试。</div>
      ) : query.isLoading ? (
        <div className="empty-small">正在读取…</div>
      ) : !query.data?.items.length ? (
        <div className="empty-state recycle-empty">
          <div>
            <Trash2 size={28} strokeWidth={1.3} />
          </div>
          <h3>暂无已删除{kind === "bills" ? "账单" : "文件"}</h3>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="recycle-table">
            <thead>
              <tr>
                <th>{kind === "bills" ? "账单 / 商品" : "文件名"}</th>
                <th>
                  {kind === "bills" ? "金额 / 交易日期" : "来源 / 交易数量"}
                </th>
                <th>删除时间</th>
                <th>到期日</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <button
                      className="recycle-entry-title"
                      onClick={() => setDetail(e)}
                    >
                      <strong>{title(e)}</strong>
                      <small>
                        {kind === "bills"
                          ? [
                              e.description !== e.merchant ? e.description : "",
                              e.platform,
                              e.kind === "refund"
                                ? "退款"
                                : e.kind === "expense"
                                  ? "支出"
                                  : "其他",
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "账单文件"}
                      </small>
                    </button>
                  </td>
                  <td>
                    <strong className="recycle-amount">
                      {kind === "bills" ? money(e.amount || 0) : e.platform}
                    </strong>
                    <small>
                      {kind === "bills" ? e.time : `${e.row_count} 条交易`}
                    </small>
                  </td>
                  <td>
                    <small>{stamp(e.deleted_at)}</small>
                  </td>
                  <td>
                    <small>{date(e.expires_at)}</small>
                    {e.expires_at <= Date.now() / 1000 && <Badge>已到期</Badge>}
                  </td>
                  <td>
                    <div className="recycle-row-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDetail(e)}
                      >
                        详情
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy || taskBusy || e.expires_at <= Date.now() / 1000
                        }
                        onClick={() => setRestoring(e)}
                      >
                        <ArchiveRestore size={14} />
                        恢复
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(offset > 0 || query.data?.has_more) && (
        <div className="activity-pagination">
          <span>第 {offset / 20 + 1} 页</span>
          <Button
            size="icon"
            variant="outline"
            aria-label="回收站上一页"
            disabled={!offset}
            onClick={() => setOffset((n) => Math.max(0, n - 20))}
          >
            <ChevronLeft size={15} />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="回收站下一页"
            disabled={!query.data?.has_more}
            onClick={() => setOffset((n) => n + 20)}
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      )}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name ? "已删除文件" : "已删除账单"}
        sheet
      >
        {detail && (
          <div className="recycle-detail">
            <div className="detail-hero">
              <Badge>{detail.platform}</Badge>
              <h2>{title(detail)}</h2>
              {detail.description && <p>{detail.description}</p>}
              {detail.amount !== undefined && (
                <strong>{money(detail.amount)}</strong>
              )}
            </div>
            <dl className="detail-grid">
              {[
                ["交易时间", detail.time],
                [
                  "交易类型",
                  detail.kind
                    ? detail.kind === "refund"
                      ? "退款"
                      : detail.kind === "expense"
                        ? "支出"
                        : "其他"
                    : undefined,
                ],
                ["交易单号", detail.order_id],
                ["支付方式", detail.method],
                ["支付账户", detail.account],
                ["来源文件", detail.file_name],
                [
                  "文件交易数",
                  detail.row_count !== undefined
                    ? `${detail.row_count} 条`
                    : undefined,
                ],
                ["分类", detail.category],
                ["备注", detail.note],
                ["删除时间", stamp(detail.deleted_at)],
                ["到期时间", stamp(detail.expires_at)],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          </div>
        )}
      </Modal>
      <Modal
        open={!!restoring}
        onClose={() => !busy && setRestoring(null)}
        title="恢复已删除内容"
        description={restoring ? title(restoring) : undefined}
      >
        {restoring && (
          <>
            {(restoring.batch.event_count > 1 ||
              restoring.batch.file_count > 0) && (
              <p className="confirm-note">
                恢复同次删除的 {restoring.batch.event_count} 条账单
                {restoring.batch.file_count
                  ? `和 ${restoring.batch.file_count} 个文件`
                  : ""}
                ，保留退款与合并关系。
              </p>
            )}
            <div className="modal-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRestoring(null)}
              >
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/trash/${restoring.batch_id}/restore`, {
                      method: "POST",
                      body: "{}",
                    });
                    setRestoring(null);
                    setDetail(null);
                    await Promise.all([
                      qc.invalidateQueries({ queryKey: ["trash-entries"] }),
                      qc.invalidateQueries({ queryKey: ["trash"] }),
                      qc.invalidateQueries({ queryKey: ["operations"] }),
                      onChanged(),
                    ]);
                    notify("已恢复");
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "恢复中…" : "确认恢复"}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
