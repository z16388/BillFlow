import { useMemo, useState } from "react";
import { money, statuses } from "./lib";
import { DateInput } from "./components/DateInput";
import { Badge, Button, Modal } from "./components/ui";

export type ScreenshotOrder = {
  id: string;
  time: string;
  amount: number;
  order_id: string;
  merchant: string;
  description: string;
  status: string;
  existing: boolean;
};

function amount(value: string) {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(result) ? result : null;
}

export default function DouyinOrderPicker({
  orders,
  paidAmount,
  selectedId,
  recommendedIds,
  reservedIds,
  description,
  onSelect,
  close,
}: {
  orders: ScreenshotOrder[];
  paidAmount: number | null;
  selectedId: string;
  recommendedIds: string[];
  reservedIds: string[];
  description: string;
  onSelect: (id: string) => void;
  close: () => void;
}) {
  const exactCount = orders.filter((o) => o.amount === paidAmount).length;
  const [scope, setScope] = useState(exactCount ? "exact" : "all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [status, setStatus] = useState("");
  const [existing, setExisting] = useState("");
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(selectedId);
  const lower = minimum ? amount(minimum) : null;
  const upper = maximum ? amount(maximum) : null;
  const invalid =
    (from && to && from > to ? "开始日期不能晚于结束日期" : "") ||
    ((minimum && lower === null) || (maximum && upper === null)
      ? "请输入有效金额，最多两位小数"
      : "") ||
    (lower !== null && upper !== null && lower > upper
      ? "最低金额不能大于最高金额"
      : "");
  const filtered = useMemo(() => {
    const rows = orders.filter(
      (o) =>
        !invalid &&
        (scope !== "exact" || o.amount === paidAmount) &&
        (!from || o.time.slice(0, 10) >= from) &&
        (!to || o.time.slice(0, 10) <= to) &&
        (lower === null || o.amount >= lower) &&
        (upper === null || o.amount <= upper) &&
        (!status || o.status === status) &&
        (!existing || o.existing === (existing === "yes")),
    );
    return rows.sort((a, b) => {
      if (sort === "amount-asc")
        return a.amount - b.amount || b.time.localeCompare(a.time);
      if (sort === "amount-desc")
        return b.amount - a.amount || b.time.localeCompare(a.time);
      return sort === "date-asc"
        ? a.time.localeCompare(b.time)
        : b.time.localeCompare(a.time);
    });
  }, [
    orders,
    invalid,
    scope,
    paidAmount,
    from,
    to,
    lower,
    upper,
    status,
    existing,
    sort,
  ]);
  const pageSize = 8;
  const maxPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, maxPage);
  const chosen = orders.find((o) => o.id === selected);
  const available = chosen && !reservedIds.includes(chosen.id);
  function reset() {
    setScope("all");
    setFrom("");
    setTo("");
    setMinimum("");
    setMaximum("");
    setStatus("");
    setExisting("");
    setSort("date-desc");
    setPage(0);
  }
  return (
    <Modal
      open
      onClose={close}
      title="选择关联账单"
      description="按日期、金额和状态筛选，核对后选择一笔。"
      wide
    >
      <div className="douyin-picker-context">
        <div>
          <small>当前截图订单</small>
          <strong>{description || "未填写商户或商品"}</strong>
        </div>
        <div>
          <small>截图实付款</small>
          <strong>{paidAmount === null ? "未识别" : money(paidAmount)}</strong>
        </div>
      </div>
      <div className="douyin-picker-scope" role="group" aria-label="候选范围">
        <Button
          variant={scope === "all" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setScope("all");
            setPage(0);
          }}
        >
          全部账单 · {orders.length}
        </Button>
        <Button
          variant={scope === "exact" ? "default" : "outline"}
          size="sm"
          disabled={!exactCount}
          onClick={() => {
            setScope("exact");
            setPage(0);
          }}
        >
          同金额 · {exactCount}
        </Button>
        {!exactCount && <span>没有同金额候选，已展示全部抖音账单</span>}
      </div>
      <div className="douyin-picker-filters" onChange={() => setPage(0)}>
        <label>
          开始日期
          <DateInput
            type="date"
            aria-label="关联账单开始日期"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <DateInput
            type="date"
            aria-label="关联账单结束日期"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          最低金额（元）
          <input
            inputMode="decimal"
            placeholder="不限"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
          />
        </label>
        <label>
          最高金额（元）
          <input
            inputMode="decimal"
            placeholder="不限"
            value={maximum}
            onChange={(e) => setMaximum(e.target.value)}
          />
        </label>
        <label>
          账单状态
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {[...new Set(orders.map((o) => o.status))].map((s) => (
              <option key={s} value={s}>
                {statuses[s] || s}
              </option>
            ))}
          </select>
        </label>
        <label>
          补充信息
          <select
            value={existing}
            onChange={(e) => setExisting(e.target.value)}
          >
            <option value="">全部</option>
            <option value="no">尚未补充</option>
            <option value="yes">已经补充</option>
          </select>
        </label>
        <label>
          排列方式
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="date-desc">日期从新到旧</option>
            <option value="date-asc">日期从旧到新</option>
            <option value="amount-asc">金额从低到高</option>
            <option value="amount-desc">金额从高到低</option>
          </select>
        </label>
        <Button variant="ghost" size="sm" onClick={reset}>
          清除筛选
        </Button>
      </div>
      {invalid && (
        <div className="screenshot-error" role="alert">
          {invalid}
        </div>
      )}
      <div className="douyin-picker-table">
        <table aria-label="抖音关联账单候选">
          <thead>
            <tr>
              <th>选择</th>
              <th>交易时间</th>
              <th>商户 / 商品</th>
              <th>原付金额</th>
              <th>账单状态</th>
              <th>订单号</th>
            </tr>
          </thead>
          <tbody>
            {filtered
              .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
              .map((o) => {
                const reserved = reservedIds.includes(o.id);
                const difference =
                  paidAmount === null ? null : o.amount - paidAmount;
                return (
                  <tr
                    key={o.id}
                    className={selected === o.id ? "is-selected" : ""}
                    onClick={() => !reserved && setSelected(o.id)}
                  >
                    <td>
                      <input
                        type="radio"
                        name="douyin-association"
                        aria-label={`选择账单 ${o.order_id || o.id}`}
                        checked={selected === o.id}
                        disabled={reserved}
                        onChange={() => setSelected(o.id)}
                      />
                    </td>
                    <td>
                      <strong>{o.time.slice(0, 10)}</strong>
                      <small>{o.time.slice(11, 19)}</small>
                    </td>
                    <td>
                      <strong>{o.merchant || "无商户"}</strong>
                      <span>{o.description || "无商品描述"}</span>
                      {recommendedIds.includes(o.id) && (
                        <Badge tone="blue">顺序候选</Badge>
                      )}
                      {o.existing && <Badge>已补充</Badge>}
                      {reserved && <small>其他截图条目已选中此账单</small>}
                    </td>
                    <td className="douyin-picker-money">
                      <strong>{money(o.amount)}</strong>
                      {difference !== null && difference !== 0 && (
                        <small>
                          差额 {difference > 0 ? "+" : "−"}
                          {money(Math.abs(difference))}
                        </small>
                      )}
                    </td>
                    <td>
                      <Badge>{statuses[o.status] || o.status}</Badge>
                    </td>
                    <td className="douyin-picker-order-id">
                      {o.order_id || "无订单号"}
                    </td>
                  </tr>
                );
              })}
            {!filtered.length && (
              <tr>
                <td colSpan={6} className="douyin-picker-empty">
                  {invalid || "没有符合条件的账单，请调整或清除筛选"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="douyin-picker-pagination">
        <span>共 {filtered.length} 笔</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!currentPage}
          onClick={() => setPage(currentPage - 1)}
        >
          上一页
        </Button>
        <span>
          {currentPage + 1} / {maxPage + 1}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage >= maxPage}
          onClick={() => setPage(currentPage + 1)}
        >
          下一页
        </Button>
      </div>
      <div className="douyin-picker-footer">
        <div>
          {chosen ? (
            <>
              <strong>
                {chosen.time.slice(0, 16)} · {money(chosen.amount)}
              </strong>
              <small>
                {chosen.order_id || "无订单号"}
                {reservedIds.includes(chosen.id) ? " · 已被其他条目选中" : ""}
              </small>
            </>
          ) : (
            <span>请选择一笔账单</span>
          )}
        </div>
        <Button
          disabled={!available}
          onClick={() => {
            if (available) onSelect(chosen.id);
          }}
        >
          关联这笔账单
        </Button>
      </div>
    </Modal>
  );
}
