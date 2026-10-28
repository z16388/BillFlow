import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./lib";
import { Badge, Button, Modal } from "./components/ui";
import RecycleBin from "./RecycleBin";
import BulkBills from "./BulkBills";
import DeleteBillDialog, {
  deletionPlan,
  type DeletePlan,
} from "./DeleteBillDialog";

type Overview = {
  event_count: number;
  imported_count: number;
  linked_manual_count: number;
  file_count: number;
  trash_batches: number;
  trash_events: number;
  retention_days: number;
  fingerprint: string;
  busy: boolean;
  files: {
    id: string;
    name: string;
    platform: string;
    created: string;
    import_enabled: boolean;
    event_count: number;
    visible_count: number;
  }[];
};
export default function DataManagement({
  notify,
  onChanged,
  initialTab = "imports",
  openExpense,
}: {
  notify: (text: string, error?: boolean) => void;
  onChanged: () => Promise<void>;
  initialTab?: string;
  openExpense: (id: string) => void;
}) {
  const qc = useQueryClient();
  const query = useQuery<Overview>({
    queryKey: ["data-management"],
    queryFn: () => api("/data-management"),
    refetchInterval: 15000,
  });
  const [tab, setTab] = useState(initialTab);
  const [confirm, setConfirm] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileDeletion, setFileDeletion] = useState<DeletePlan | null>(null);
  const [fileState, setFileState] = useState<any>(null);
  const data = query.data;
  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["data-management"] }),
      qc.invalidateQueries({ queryKey: ["trash"] }),
      qc.invalidateQueries({ queryKey: ["trash-entries"] }),
    ]);
  }
  async function mutate(path: string, body: object, text: string) {
    setBusy(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setConfirm(null);
      await Promise.all([refresh(), onChanged()]);
      notify(text);
    } catch (e) {
      setConfirm(null);
      notify((e as Error).message, true);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="data-management">
      <section className="card management-card">
        <div className="management-summary">
          <div>
            <span>账单文件</span>
            <strong>
              {data?.file_count ?? "—"}
              <small>个</small>
            </strong>
          </div>
          <div>
            <span>关联账单</span>
            <strong>
              {data?.imported_count ?? "—"}
              <small>笔</small>
            </strong>
          </div>
          <div>
            <span>回收站交易</span>
            <strong>
              {data?.trash_events ?? "—"}
              <small>笔</small>
            </strong>
          </div>
        </div>
        <div className="kind-tabs">
          {[
            ["imports", "导入文件管理"],
            ["bills", "账单管理"],
            ["trash", "回收站"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          <Button
            className="management-refresh"
            variant="ghost"
            size="icon"
            onClick={refresh}
            aria-label="刷新数据管理"
          >
            <RefreshCw size={15} />
          </Button>
        </div>
        {query.isError && (
          <div className="notice warning">无法读取数据，请刷新重试。</div>
        )}
        {tab === "imports" ? (
          <>
            <div className="management-action">
              <div>
                <p>取消导入可随时恢复；删除后移入回收站。</p>
              </div>
              <Button
                variant="danger"
                disabled={
                  busy ||
                  !data ||
                  (!data.event_count && !data.file_count) ||
                  data.busy
                }
                onClick={() => setConfirm(data!)}
              >
                <Trash2 size={15} />
                删除全部导入文件
              </Button>
            </div>
            {data?.busy && (
              <div className="notice small">
                有导入或同步任务正在执行，结束后可清除或恢复。
              </div>
            )}
            {!data?.files.length ? (
              <div className="empty-small">
                暂无已导入文件。可以先到工作台导入账单。
              </div>
            ) : (
              <div className="managed-file-list">
                {data.files.map((file) => (
                  <div className="managed-file" key={file.id}>
                    <FileSpreadsheet size={17} />
                    <div className="managed-file-info">
                      <strong>{file.name}</strong>
                      <small>
                        {file.platform} · {file.created} UTC
                      </small>
                      <small>
                        关联 {file.event_count} 笔 · 当前可见{" "}
                        {file.visible_count} 笔
                      </small>
                    </div>
                    <Badge tone={file.import_enabled ? "blue" : "neutral"}>
                      {file.import_enabled ? "已导入" : "已取消导入"}
                    </Badge>
                    <div className="file-row-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || data.busy}
                        onClick={async () => {
                          try {
                            setFileState(
                              await api(
                                `/data-management/files/${file.id}/import-state`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    enabled: !file.import_enabled,
                                  }),
                                },
                              ),
                            );
                          } catch (e) {
                            notify((e as Error).message, true);
                          }
                        }}
                      >
                        {file.import_enabled ? "取消导入" : "恢复导入"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || data.busy}
                        onClick={async () => {
                          try {
                            setFileDeletion(
                              await deletionPlan("files", [file.id]),
                            );
                          } catch (e) {
                            notify((e as Error).message, true);
                          }
                        }}
                      >
                        删除文件
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : tab === "bills" ? (
          <BulkBills
            notify={notify}
            onOpen={openExpense}
            onChanged={onChanged}
          />
        ) : (
          <RecycleBin
            notify={notify}
            taskBusy={!!data?.busy}
            onChanged={async () => {
              await Promise.all([refresh(), onChanged()]);
            }}
          />
        )}
      </section>
      <DeleteBillDialog
        plan={fileDeletion}
        onClose={() => setFileDeletion(null)}
        notify={notify}
        onDone={async () => {
          await Promise.all([refresh(), onChanged()]);
        }}
      />
      <Modal
        open={!!fileState}
        onClose={() => !busy && setFileState(null)}
        title={fileState?.import_enabled ? "重新启用文件导入" : "取消文件导入"}
        description={fileState?.name}
      >
        {fileState && (
          <>
            <p className="management-caption">
              {fileState.import_enabled
                ? `重新启用后，将恢复显示 ${fileState.restored_count} 笔交易。`
                : `隐藏 ${fileState.hidden_count} 条关联交易，可随时恢复导入。`}
            </p>
            <div className="modal-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setFileState(null)}
              >
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(
                      `/data-management/files/${fileState.file_id}/import-state`,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          enabled: fileState.import_enabled,
                          fingerprint: fileState.fingerprint,
                        }),
                      },
                    );
                    setFileState(null);
                    await Promise.all([refresh(), onChanged()]);
                    notify("文件导入状态已更新");
                  } catch (e) {
                    setFileState(null);
                    notify((e as Error).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                确认{fileState.import_enabled ? "恢复导入" : "取消导入"}
              </Button>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={!!confirm}
        onClose={() => !busy && setConfirm(null)}
        title="确认清除导入账单"
        description="数据会移入当前账号的回收站。"
        wide
      >
        {confirm && (
          <>
            <div className="clear-counts">
              <strong>{confirm.imported_count} 笔导入交易</strong>
              <span>{confirm.file_count} 个已导入文件</span>
              {confirm.linked_manual_count > 0 && (
                <span>
                  另有 {confirm.linked_manual_count} 笔关联手动记录一同移入
                </span>
              )}
            </div>
            <p className="management-caption">
              移入回收站，{confirm.retention_days} 天内可恢复。
            </p>
            <div className="modal-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  mutate(
                    "/data-management/clear-imports",
                    { fingerprint: confirm.fingerprint },
                    "导入账单已移入回收站",
                  )
                }
              >
                {busy ? "处理中…" : "确认移入回收站"}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
