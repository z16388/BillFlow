import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "./lib";
import { Button } from "./components/ui";
import { DateInput } from "./components/DateInput";
import { todayString } from "./dates";
function emptyForm() {
  return {
    time:
      todayString() +
      "T" +
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date()),
    merchant: "",
    description: "",
    amount: "",
    category: "未分类",
    method: "",
    note: "",
    request_id: crypto.randomUUID(),
  };
}
export default function ManualExpense({
  onSaved,
  notify,
}: {
  onSaved: (id: string, keepOpen: boolean) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);
  const merchant = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  return (
    <form
      className="manual-form manual-sheet"
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        try {
          const result = await api("/expenses/manual", {
            method: "POST",
            body: JSON.stringify(form),
          });
          await onSaved(result.id, keepOpen);
          if (keepOpen) {
            setForm(emptyForm());
            merchant.current?.focus();
          }
        } catch (err) {
          notify((err as Error).message, true);
        } finally {
          submitting.current = false;
          setBusy(false);
        }
      }}
    >
      <div className="manual-hero">
        <label className="manual-amount-label">
          支出金额（元）
          <div>
            <span>¥</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              max="999999999.99"
              step="0.01"
              required
              aria-label="支出金额（元）"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>
        </label>
      </div>
      <div className="manual-fields">
        <h3>交易信息</h3>
        <label className="field">
          商户
          <input
            ref={merchant}
            required
            maxLength={200}
            placeholder="例如：楼下便利店"
            value={form.merchant}
            onChange={(e) => setForm({ ...form, merchant: e.target.value })}
          />
        </label>
        <label className="field">
          商品 / 描述
          <input
            maxLength={1000}
            placeholder="这笔支出买了什么"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className="field">
          交易时间
          <DateInput
            type="datetime-local"
            required
            value={form.time}
            onInput={(e) => setForm({ ...form, time: e.currentTarget.value })}
            onChange={(e) => setForm({ ...form, time: e.target.value })}
          />
        </label>
        <div className="form-grid">
          <label className="field">
            分类
            <input
              maxLength={80}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          </label>
          <label className="field">
            支付方式
            <input
              maxLength={80}
              placeholder="例如：现金"
              value={form.method}
              onChange={(e) => setForm({ ...form, method: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          备注
          <textarea
            maxLength={2000}
            rows={3}
            placeholder="可选，补充这笔消费的说明"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>
      </div>
      <div className="manual-footer">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={keepOpen}
            onChange={(e) => setKeepOpen(e.target.checked)}
          />
          继续添加
        </label>
        <Button type="submit" disabled={busy}>
          <Plus size={15} />
          {busy ? "保存中…" : "保存账单"}
        </Button>
      </div>
    </form>
  );
}
