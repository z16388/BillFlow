import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "./lib";
import { formatFeishuDate } from "./feishuDate";
import { Badge, Button, Modal } from "./components/ui";
import "./sync-check.css";

type Check = {
  expense_id: string;
  description: string;
  state: string;
  retryable: boolean;
  record_id: string | null;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  differences: { field: string; expected: unknown; actual: unknown }[];
  types: Record<string, number>;
};
const names: Record<string, string> = {
  matched: "已写入且一致",
  missing: "未找到记录",
  different: "字段有差异",
  duplicate: "同步键重复",
  conflict: "记录身份冲突",
};
function display(value: unknown, kind: number) {
  if (value === null || value === undefined || value === "") return "未填写";
  if (kind === 5) return formatFeishuDate(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return Array.isArray(value) ? value.join("、") : String(value);
}
export default function SyncCheck({
  jobId,
  close,
  refresh,
  notify,
}: {
  jobId: string;
  close: () => void;
  refresh: () => Promise<void>;
  notify: (s: string, e?: boolean) => void;
}) {
  const [data, setData] = useState<{ items: Check[] } | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0),
    [selected, setSelected] = useState<Record<string, boolean>>({});
  async function load() {
    setLoading(true);
    setError("");
    setSelected({});
    try {
      setData(await api(`/jobs/${jobId}/check`, { method: "POST" }));
      setPage(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [jobId]);
  const items = data?.items || [],
    matched = items.filter((i) => i.state === "matched").length;
  const chosen = items.filter((i) => i.retryable && selected[i.expense_id]);
  const pages = Math.max(1, Math.ceil(items.length / 5));
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/jobs/${jobId}/confirm-check`, {
        method: "POST",
      });
      await refresh();
      notify(`已确认 ${result.confirmed} 笔写入成功`);
      setData(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      await api(`/jobs/${jobId}/retry`, {
        method: "POST",
        body: JSON.stringify({ ids: chosen.map((i) => i.expense_id) }),
      });
      await refresh();
      notify(`已提交 ${chosen.length} 笔重试任务`);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={close}
      title="核对同步结果"
      description="先读取飞书逐笔对比，选择操作后才会处理。"
      wide
    >
      {loading ? (
        <div className="sync-check-loading">
          <Loader2 className="spin" size={20} />
          正在读取飞书记录…
        </div>
      ) : (
        <>
          {error && (
            <div className="notice warning" role="alert">
              {error}
            </div>
          )}
          {data && (
            <>
              <div className="sync-check-summary">
                <span>共 {items.length} 笔</span>
                <strong>一致 {matched}</strong>
                <span>
                  未找到 {items.filter((i) => i.state === "missing").length}
                </span>
                <span>
                  需核对{" "}
                  {
                    items.filter(
                      (i) => !["matched", "missing"].includes(i.state),
                    ).length
                  }
                </span>
              </div>
              <p className="sync-check-note">
                确认成功只修正本地状态；有差异的字段会在下方标出。勾选并重试会实际写入飞书。
              </p>
              <div className="sync-check-items">
                {items.slice(page * 5, (page + 1) * 5).map((i) => (
                  <article key={i.expense_id} className="sync-check-item">
                    <header>
                      <strong>{i.description || "未命名消费"}</strong>
                      <Badge tone={i.state === "matched" ? "green" : "amber"}>
                        {names[i.state] || i.state}
                      </Badge>
                      {i.retryable && (
                        <label>
                          <input
                            type="checkbox"
                            checked={!!selected[i.expense_id]}
                            onChange={(e) =>
                              setSelected((s) => ({
                                ...s,
                                [i.expense_id]: e.target.checked,
                              }))
                            }
                          />
                          选择重试
                        </label>
                      )}
                    </header>
                    <small>
                      {i.record_id
                        ? `飞书记录：${i.record_id}`
                        : "飞书尚未找到对应记录"}
                    </small>
                    {i.state === "different" && !i.retryable && (
                      <p>远端内容与计划不同，请核对后重新生成同步预览。</p>
                    )}
                    {["duplicate", "conflict"].includes(i.state) && (
                      <p>请先检查远端同步键及记录，处理后再核对。</p>
                    )}
                    <details>
                      <summary>
                        {i.differences.length
                          ? `查看 ${i.differences.length} 项差异`
                          : "查看逐字段对比"}
                      </summary>
                      <div className="sync-check-fields">
                        <table>
                          <thead>
                            <tr>
                              <th>字段</th>
                              <th>本次计划</th>
                              <th>飞书回读</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(i.expected).map(([name, value]) => (
                              <tr
                                key={name}
                                className={
                                  i.differences.some((d) => d.field === name)
                                    ? "has-difference"
                                    : ""
                                }
                              >
                                <th>{name}</th>
                                <td>{display(value, i.types[name])}</td>
                                <td>
                                  {display(i.actual[name], i.types[name])}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
              <div className="sync-check-pages">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <span>
                  {page + 1} / {pages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pages - 1}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </div>
            </>
          )}
          <div className="sync-check-footer">
            <Button variant="outline" disabled={busy} onClick={load}>
              重新读取
            </Button>
            <div>
              {chosen.length > 0 && (
                <Button variant="outline" disabled={busy} onClick={retry}>
                  确认重试 {chosen.length} 笔
                </Button>
              )}
              <Button disabled={busy || !matched} onClick={confirm}>
                {busy ? "处理中…" : `确认 ${matched} 笔已成功`}
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
