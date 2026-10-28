import { useState } from "react";
import { api, money, type Expense } from "./lib";
import { Badge, Button, Modal } from "./components/ui";
import { DateInput } from "./components/DateInput";
import {
  Pencil,
  Sparkles,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import "./sync-preview.css";
import { formatFeishuDate } from "./feishuDate";
import SyncOriginalDetail from "./SyncOriginalDetail";
export default function SyncPreviewItems({
  preview,
  onChange,
  notify,
  onRefresh,
  expenses,
}: {
  preview: any;
  expenses: Expense[];
  onChange: (p: any) => void;
  notify: (s: string, error?: boolean) => void;
  onRefresh: () => Promise<any>;
}) {
  const [editing, setEditing] = useState<any>(null),
    [values, setValues] = useState<Record<string, any>>({});
  const [rule, setRule] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const fields = (preview.fields || []).filter(
    (f: any) =>
      [1, 2, 3, 4, 5, 7].includes(f.type) &&
      !f.is_readonly &&
      f.field_name !== preview.sync_key_field,
  );
  const [originalId, setOriginalId] = useState<string | null>(null);
  const original = expenses.find((e) => e.id === originalId);
  const [page, setPage] = useState(0),
    [pageSize, setPageSize] = useState(5);
  const pageCount = Math.max(1, Math.ceil(preview.items.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = preview.items.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const columns = fields.filter(
    (f: any) =>
      preview.items.some((i: any) => i.fields[f.field_name] !== undefined) ||
      [3, 4].includes(f.type),
  );
  function displayValue(field: any, value: any) {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    )
      return "未填写";
    if (field.type === 5)
      return formatFeishuDate(value, field.property?.date_formatter);
    if (Array.isArray(value)) return value.join("、");
    if (typeof value === "boolean") return value ? "是" : "否";
    return String(value);
  }
  const ruleFields = fields.filter((f: any) => [1, 3, 4].includes(f.type));
  const dateText = (v: any) =>
    v ? new Date(Number(v) + 8 * 3600 * 1000).toISOString().slice(0, 16) : "";
  function input(
    field: any,
    value: any,
    change: (v: any) => void,
    label: string,
  ) {
    if (field.type === 3 || field.type === 4)
      return (
        <select
          aria-label={label}
          multiple={field.type === 4}
          value={
            field.type === 4
              ? Array.isArray(value)
                ? value
                : String(value || "")
                    .split("、")
                    .filter(Boolean)
              : (value ?? "")
          }
          onChange={(e) =>
            change(
              field.type === 4
                ? Array.from(e.target.selectedOptions, (o) => o.value)
                : e.target.value,
            )
          }
        >
          {field.type === 3 && <option value="">未填写</option>}
          {(field.property?.options || []).map((o: any) => (
            <option key={o.name} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
      );
    if (field.type === 7)
      return (
        <select
          aria-label={label}
          value={
            value === true || value === "true"
              ? "true"
              : value === false || value === "false"
                ? "false"
                : ""
          }
          onChange={(e) => change(e.target.value)}
        >
          <option value="">未填写</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      );
    if (field.type === 5)
      return (
        <DateInput
          aria-label={label}
          type="datetime-local"
          value={typeof value === "number" ? dateText(value) : value || ""}
          onChange={(e) => change(e.target.value)}
        />
      );
    return (
      <input
        aria-label={label}
        type={field.type === 2 ? "number" : "text"}
        step="0.01"
        maxLength={10000}
        value={value ?? ""}
        onChange={(e) => change(e.target.value)}
      />
    );
  }
  async function saveEdit() {
    setBusy(true);
    try {
      const result = await api(
        `/sync/preview/${preview.id}/items/${editing.expense_id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            values: Object.fromEntries(
              Object.entries(values).filter(([name, value]) => {
                const f = fields.find((f: any) => f.field_name === name);
                const before =
                  f?.type === 5
                    ? dateText(editing.fields[name])
                    : editing.fields[name];
                return JSON.stringify(value) !== JSON.stringify(before);
              }),
            ),
            revision: preview.revision || 0,
          }),
        },
      );
      onChange(result);
      setEditing(null);
      notify("本笔内容已更新，确认同步后写入飞书");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function saveRule() {
    setBusy(true);
    try {
      const result = await api(`/sync/preview/${preview.id}/rules`, {
        method: "POST",
        body: JSON.stringify({ ...rule, revision: preview.revision || 0 }),
      });
      onChange(result);
      setRule(null);
      notify("规则已记住，本次预览已重新匹配");
      await onRefresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  function startRule(item: any) {
    const field =
      ruleFields.find((f: any) => f.field_name === "消费项目") || ruleFields[0];
    if (!field) return;
    setRule({
      field_id: field.field_id,
      source: "merchant",
      keyword: item.merchant || item.original_description,
      value: String(item.fields[field.field_name] || ""),
    });
  }
  return (
    <>
      {!!preview.setup_warnings?.length && (
        <div className="notice small">
          {preview.setup_warnings.join("；")}
          。可以先核对预览，完善账本字段后再同步。
          <a href="#settings">账本设置</a>
        </div>
      )}
      <div className="sync-preview-table-wrap">
        <table className="sync-preview-table" aria-label="本次同步记录">
          <thead>
            <tr>
              <th>原始账单</th>
              {columns.map((f: any) => (
                <th key={f.field_id}>{f.field_name}</th>
              ))}
              <th className="sync-preview-row-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((item: any) => (
              <tr
                key={item.expense_id}
                className="sync-preview-clickable-row"
                tabIndex={0}
                aria-label={`查看原始账单：${item.merchant || item.description}`}
                onClick={(e) => {
                  if (!(e.target as Element).closest("button,input,select,a"))
                    setOriginalId(item.expense_id);
                }}
                onKeyDown={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    (e.key === "Enter" || e.key === " ")
                  ) {
                    e.preventDefault();
                    setOriginalId(item.expense_id);
                  }
                }}
              >
                <td className="sync-preview-source-cell">
                  <div>
                    <Badge tone="blue">
                      {item.action === "create" ? "新增" : "更新"}
                    </Badge>
                    <button
                      type="button"
                      className="sync-preview-original-link"
                      title="查看原始账单详情"
                      onClick={() => setOriginalId(item.expense_id)}
                    >
                      {item.merchant || item.description}
                    </button>
                  </div>
                  <small title={item.original_description}>
                    {item.original_description || "—"}
                  </small>
                  {item.manual_fields && (
                    <small className="sync-preview-edited">已手动调整</small>
                  )}
                  {!!item.warnings?.length && (
                    <small
                      className="sync-preview-rule-warning"
                      title={item.warnings.join("；")}
                    >
                      {item.warnings.join("；")}
                    </small>
                  )}
                </td>
                {columns.map((f: any) => (
                  <td
                    key={f.field_id}
                    title={displayValue(f, item.fields[f.field_name])}
                  >
                    <span
                      className={
                        item.fields[f.field_name] === undefined
                          ? "sync-preview-blank"
                          : ""
                      }
                    >
                      {displayValue(f, item.fields[f.field_name])}
                    </span>
                    {item.action === "update" &&
                      f.type === 2 &&
                      /金额|支出/.test(f.field_name) && (
                        <small className="sync-preview-before">
                          原 {money(item.before_amount || 0)}
                        </small>
                      )}
                  </td>
                ))}
                <td className="sync-preview-row-actions">
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(item);
                        setValues(
                          Object.fromEntries(
                            fields
                              .filter(
                                (f: any) =>
                                  item.fields[f.field_name] !== undefined,
                              )
                              .map((f: any) => [
                                f.field_name,
                                f.type === 5
                                  ? dateText(item.fields[f.field_name])
                                  : item.fields[f.field_name],
                              ]),
                          ),
                        );
                      }}
                    >
                      {" "}
                      <Pencil size={13} />
                      修改本笔
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!ruleFields.length}
                      onClick={() => startRule(item)}
                    >
                      <Sparkles size={13} />
                      记住匹配规则
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="sync-preview-pagination" aria-label="同步预览分页">
        <span>
          共 {preview.items.length} 笔 · 第 {currentPage + 1} / {pageCount}{" "}
          页（同步包含全部页）
        </span>
        <label>
          每页
          <select
            aria-label="同步预览每页条数"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
          >
            <option value={5}>5 笔</option>
            <option value={10}>10 笔</option>
            <option value={20}>20 笔</option>
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          aria-label="同步预览上一页"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          <ChevronLeft size={14} />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="同步预览下一页"
          disabled={currentPage >= pageCount - 1}
          onClick={() => setPage(currentPage + 1)}
        >
          下一页
          <ChevronRight size={14} />
        </Button>
      </nav>
      <Modal
        open={!!originalId}
        onClose={() => setOriginalId(null)}
        title="原始账单详情"
        description="查看导入证据及退款，便于对照本次同步内容。"
        sheet
      >
        {original ? (
          <SyncOriginalDetail expense={original} />
        ) : (
          <div className="notice small">
            原始账单已发生变化或不可见，请返回工作台刷新后重新预览。
          </div>
        )}
        <div className="modal-actions">
          <Button variant="outline" onClick={() => setOriginalId(null)}>
            返回同步预览
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="修改本笔同步内容"
        description="只影响这笔账单的写入内容；金额单位为元。"
        sheet
      >
        <div className="sync-preview-form">
          {fields.map((f: any) => (
            <label className="field" key={f.field_id}>
              {f.field_name}
              {input(
                f,
                values[f.field_name],
                (v) => setValues({ ...values, [f.field_name]: v }),
                `修改${f.field_name}`,
              )}
            </label>
          ))}
          <p>
            同步键由工具自动维护。单笔修改在同步成功后记住；后续退款仍会重新计算净额。
          </p>
        </div>
        <div className="modal-actions">
          <Button variant="outline" onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button disabled={busy} onClick={saveEdit}>
            {busy && <Loader2 size={14} className="spin" />}应用到本次预览
          </Button>
        </div>
      </Modal>
      <Modal
        open={!!rule}
        onClose={() => setRule(null)}
        title="记住一个简单规则"
        description="例如：商户包含「南城香」时，消费项目填写「午饭」。保存后应用到本次和后续账单。"
        sheet
      >
        {rule && (
          <div className="sync-preview-form">
            <label className="field">
              要填写哪一项
              <select
                aria-label="规则目标字段"
                value={rule.field_id}
                onChange={(e) =>
                  setRule({ ...rule, field_id: e.target.value, value: "" })
                }
              >
                {ruleFields.map((f: any) => (
                  <option key={f.field_id} value={f.field_id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              根据什么匹配
              <select
                value={rule.source}
                onChange={(e) => setRule({ ...rule, source: e.target.value })}
              >
                <option value="merchant">商户包含</option>
                <option value="description">商品包含</option>
                <option value="platform">账单来源包含</option>
              </select>
            </label>
            <label className="field">
              包含这些文字
              <input
                maxLength={300}
                value={rule.keyword}
                onChange={(e) => setRule({ ...rule, keyword: e.target.value })}
              />
            </label>
            <label className="field">
              自动填写为
              {input(
                ruleFields.find((f: any) => f.field_id === rule.field_id),
                rule.value,
                (v) =>
                  setRule({
                    ...rule,
                    value: Array.isArray(v) ? v.join("、") : v,
                  }),
                "规则填写结果",
              )}
            </label>
            <p>
              未匹配的账单保持原来的内容；手动修改本笔的内容优先。更复杂的条件仍可在设置中配置。
            </p>
          </div>
        )}
        <div className="modal-actions">
          <Button variant="outline" onClick={() => setRule(null)}>
            取消
          </Button>
          <Button
            disabled={busy || !rule?.keyword?.trim() || !rule?.value?.trim()}
            onClick={saveRule}
          >
            {busy && <Loader2 size={14} className="spin" />}记住并更新预览
          </Button>
        </div>
      </Modal>
    </>
  );
}
