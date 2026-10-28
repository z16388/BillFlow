import { useState } from "react";
import { api, money } from "./lib";
import { Button, Modal } from "./components/ui";
export type DeletePlan = {
  scope: string;
  ids: string[];
  fingerprint: string;
  event_count: number;
  file_count: number;
  requested_count: number;
  linked_count: number;
  retention_days: number;
  entries: {
    id: string;
    merchant: string;
    description: string;
    amount: number;
    time: string;
    platform: string;
  }[];
  file_names: string[];
};
export async function deletionPlan(
  scope: "events" | "files",
  ids: string[],
): Promise<DeletePlan> {
  return {
    ...(await api("/data-management/delete-preview", {
      method: "POST",
      body: JSON.stringify({ scope, ids }),
    })),
    scope,
    ids,
  };
}
export default function DeleteBillDialog({
  plan,
  onClose,
  onDone,
  notify,
}: {
  plan: DeletePlan | null;
  onClose: () => void;
  onDone: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={!!plan}
      onClose={() => !busy && onClose()}
      title={plan?.scope === "files" ? "确认删除账单文件" : "确认删除账单"}
      description={
        plan ? `移入回收站，${plan.retention_days} 天内可恢复。` : undefined
      }
    >
      {plan && (
        <>
          <div className="delete-preview">
            {plan.entries?.map((e) => (
              <article key={e.id}>
                <div>
                  <strong>{e.merchant || e.description || "账单"}</strong>
                  <strong>{money(e.amount)}</strong>
                </div>
                {e.description && e.description !== e.merchant && (
                  <p>{e.description}</p>
                )}
                <small>
                  {e.time} · {e.platform}
                </small>
              </article>
            ))}
            {plan.file_names?.map((name) => (
              <strong className="delete-file-name" key={name}>
                {name}
              </strong>
            ))}
          </div>
          {plan.linked_count > 0 && (
            <p className="muted confirm-note">
              另有 {plan.linked_count} 条关联退款或合并记录一同移入。
            </p>
          )}
          {plan.scope === "files" && (
            <p className="muted confirm-note">
              包含 {plan.event_count} 条交易，飞书记录保留。
            </p>
          )}
          <div className="modal-actions">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/data-management/delete", {
                    method: "POST",
                    body: JSON.stringify({
                      scope: plan.scope,
                      ids: plan.ids,
                      fingerprint: plan.fingerprint,
                    }),
                  });
                  onClose();
                  await onDone();
                  notify("已移入回收站");
                } catch (e) {
                  onClose();
                  notify((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "删除中…" : "确认删除"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
