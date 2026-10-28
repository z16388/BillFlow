import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { CheckCheck, X, Eye, MinusCircle, RotateCcw } from "lucide-react";
import { api, money, statuses, type Expense, type LedgerData } from "./lib";
import { Badge, Button } from "./components/ui";
import SharedFilters, { SOURCES } from "./components/SharedFilters";
import { dateRange } from "./dates";
export default function BulkBills({
  notify,
  onOpen,
  onChanged,
}: {
  notify: (s: string, error?: boolean) => void;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const data = useQuery<LedgerData>({
    queryKey: ["data"],
    queryFn: () => api("/data"),
  });
  const [sources, setSources] = useState([...SOURCES]);
  const [from, setFrom] = useState(() => dateRange("month")[0]);
  const [to, setTo] = useState(() => dateRange("month")[1]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = useMemo(
    () =>
      (data.data?.expenses || []).filter(
        (e) =>
          sources.some((p) => e.platforms.includes(p)) &&
          (!from || e.time.slice(0, 10) >= from) &&
          (!to || e.time.slice(0, 10) <= to) &&
          (!search ||
            [e.merchant, e.description, e.order_id, e.sync_description]
              .join(" ")
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (status === "all" ||
            (status === "pending" && ["new", "update"].includes(e.status)) ||
            e.status === status),
      ),
    [data.data, sources, from, to, search, status],
  );
  const chosen = (data.data?.expenses || []).filter((e) => selected.has(e.id));
  function toggle(id: string, checked: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  }
  async function change(excluded: boolean) {
    setBusy(true);
    try {
      const result = await api("/expenses/bulk-exclusion", {
        method: "POST",
        body: JSON.stringify({ ids: chosen.map((e) => e.id), excluded }),
      });
      setSelected(new Set());
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["data"] }),
        qc.invalidateQueries({ queryKey: ["operations"] }),
        onChanged(),
      ]);
      notify(`${excluded ? "已排除" : "已取消排除"} ${result.changed} 笔账单`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const columns = useMemo<ColumnDef<Expense>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => {
          const page = table.getRowModel().rows;
          const checked = page.filter((r) =>
            selected.has(r.original.id),
          ).length;
          return (
            <input
              type="checkbox"
              aria-label="选择当前页"
              checked={page.length > 0 && checked === page.length}
              ref={(el) => {
                if (el) el.indeterminate = checked > 0 && checked < page.length;
              }}
              disabled={!page.length || busy}
              onChange={(e) => {
                const checked = e.target.checked;
                setSelected((s) => {
                  const next = new Set(s);
                  page.forEach((r) =>
                    checked
                      ? next.add(r.original.id)
                      : next.delete(r.original.id),
                  );
                  return next;
                });
              }}
            />
          );
        },
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={
              "管理选择 " + (row.original.merchant || row.original.description)
            }
            checked={selected.has(row.original.id)}
            onChange={(e) => toggle(row.original.id, e.target.checked)}
          />
        ),
      },
      {
        accessorKey: "time",
        header: "交易时间",
        cell: ({ row }) => (
          <div className="bulk-date">
            {row.original.time.slice(0, 10)}
            <small>{row.original.time.slice(11)}</small>
          </div>
        ),
      },
      {
        id: "merchant",
        header: "商户 / 商品",
        cell: ({ row }) => (
          <button
            className="bulk-merchant"
            onClick={() => onOpen(row.original.id)}
          >
            <strong>{row.original.merchant || "未提供商户"}</strong>
            <small>
              {row.original.sync_description ||
                row.original.description ||
                "未提供商品"}
            </small>
          </button>
        ),
      },
      {
        id: "platform",
        header: "来源",
        cell: ({ row }) => (
          <span className="bulk-source">
            {row.original.platforms.join(" / ")}
          </span>
        ),
      },
      {
        accessorKey: "net",
        header: "净支出",
        cell: ({ row }) => (
          <strong className="number net-number">
            {money(row.original.net)}
          </strong>
        ),
      },
      {
        accessorKey: "status",
        header: "处理状态",
        cell: ({ row }) => (
          <Badge
            tone={
              row.original.status === "excluded"
                ? "neutral"
                : ["new", "update"].includes(row.original.status)
                  ? "blue"
                  : "amber"
            }
          >
            {statuses[row.original.status]}
          </Badge>
        ),
      },
      {
        id: "detail",
        header: "",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            aria-label={"查看账单 " + row.original.merchant}
            onClick={() => onOpen(row.original.id)}
          >
            <Eye size={15} />
          </Button>
        ),
      },
    ],
    [selected, onOpen, busy],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 15 },
      sorting: [{ id: "time", desc: true }],
    },
  });
  return (
    <div className="bulk-bills">
      <SharedFilters
        sources={sources}
        onSources={setSources}
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        search={search}
        onSearch={setSearch}
      />
      <div className="bulk-status filter-tabs">
        {[
          ["all", "全部"],
          ["pending", "待同步"],
          ["review", "待确认"],
          ["recorded", "已记录"],
          ["refunded", "全额退款"],
          ["filtered", "已过滤"],
          ["excluded", "已排除"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={status === key ? "active" : ""}
            onClick={() => setStatus(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="bulk-toolbar">
        <div>
          <strong>已选择 {chosen.length} 笔</strong>
          <span>当前筛选 {rows.length} 笔</span>
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={!rows.length}
            onClick={() =>
              setSelected((s) => new Set([...s, ...rows.map((e) => e.id)]))
            }
          >
            <CheckCheck size={14} />
            选择全部结果
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!chosen.length}
            onClick={() => setSelected(new Set())}
          >
            <X size={14} />
            清除选择
          </Button>
        </div>
      </div>
      <div className="bulk-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !chosen.length}
          onClick={() => change(true)}
        >
          <MinusCircle size={14} />
          批量排除
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !chosen.length}
          onClick={() => change(false)}
        >
          <RotateCcw size={14} />
          批量取消排除
        </Button>
      </div>
      {data.isError ? (
        <div className="notice warning">账单读取失败，请刷新重试。</div>
      ) : !rows.length ? (
        <div className="empty-small">当前筛选下暂无账单</div>
      ) : (
        <div className="table-scroll">
          <table className="expense-table bulk-table">
            <thead>
              {table.getHeaderGroups().map((g) => (
                <tr key={g.id}>
                  {g.headers.map((h) => (
                    <th key={h.id}>
                      {h.column.getCanSort() ? (
                        <button
                          className="sort-header"
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            h.column.columnDef.header,
                            h.getContext(),
                          )}{" "}
                          {h.column.getIsSorted() === "desc" ? "↓" : "↕"}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={selected.has(row.original.id) ? "selected" : ""}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="activity-pagination">
        <span>
          共 {rows.length} 笔 · 第 {table.getState().pagination.pageIndex + 1} /{" "}
          {Math.max(1, table.getPageCount())} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
