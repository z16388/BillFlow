import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Save } from "lucide-react";
import { api } from "./lib";
import { Button } from "./components/ui";

export default function DataRetention({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const qc = useQueryClient();
  const query = useQuery<{ retention_days: number; version: number }>({
    queryKey: ["data-preferences"],
    queryFn: () => api("/data-preferences"),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    const days = Number(draft);
    if (!query.data || !Number.isInteger(days) || days < 1 || days > 3650) {
      notify("保留天数需为 1–3650 的整数", true);
      return;
    }
    setBusy(true);
    try {
      const result = await api("/data-preferences", {
        method: "PUT",
        body: JSON.stringify({
          retention_days: days,
          version: query.data.version,
        }),
      });
      qc.setQueryData(["data-preferences"], result);
      setDraft(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["data-management"] }),
        qc.invalidateQueries({ queryKey: ["operations"] }),
      ]);
      notify("回收站保留天数已保存，对后续清除生效");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card settings-card retention-card">
      <div className="section-head">
        <span className="icon-box">
          <Clock3 size={20} />
        </span>
        <div>
          <h2>回收站设置</h2>
        </div>
      </div>
      {query.isError ? (
        <p className="error-text">无法读取设置，请刷新重试。</p>
      ) : !query.data ? (
        <p className="muted">正在读取设置…</p>
      ) : (
        <>
          <div className="retention-controls">
            <label className="field">
              回收站保留天数
              <div>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={draft ?? String(query.data.retention_days)}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="回收站保留天数"
                />
                <span>天</span>
              </div>
            </label>
            <Button
              variant="outline"
              disabled={
                busy ||
                draft === null ||
                Number(draft) === query.data.retention_days
              }
              onClick={save}
            >
              <Save size={14} />
              {busy ? "保存中…" : "保存保留天数"}
            </Button>
          </div>
          <p className="retention-note">
            仅对之后删除的内容生效；到期自动清理。
          </p>
        </>
      )}
    </section>
  );
}
