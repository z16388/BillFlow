import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDropzone } from "react-dropzone";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  History,
  Inbox,
  Info,
  LayoutGrid,
  Link2,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wallet,
  X,
} from "lucide-react";
import {
  api,
  money,
  statuses,
  type Expense,
  type LedgerData,
  type Refund,
} from "./lib";
import { Badge, Button, Modal } from "./components/ui";
import Settings from "./Settings";
import DouyinScreenshots from "./DouyinScreenshots";
import SyncPreviewItems from "./SyncPreviewItems";
import SyncCheck from "./SyncCheck";
import Guide from "./Guide";
import Accounts from "./Accounts";
import Activity from "./Activity";
import ManualExpense from "./ManualExpense";
import DataManagement from "./DataManagement";
import DeleteBillDialog, {
  deletionPlan,
  type DeletePlan,
} from "./DeleteBillDialog";
import { dateRange } from "./dates";
import { Users, Database } from "lucide-react";
import Customization from "./Customization";
import SharedFilters, { SOURCES } from "./components/SharedFilters";

const sourceClass: Record<string, string> = {
  微信: "wechat",
  支付宝: "alipay",
  京东: "jd",
  美团: "meituan",
  抖音: "douyin",
  手动: "manual",
};
function Source({ name }: { name: string }) {
  return (
    <span className={"source source-" + sourceClass[name]}>
      <i />
      {name}
    </span>
  );
}
function Status({ value }: { value: string }) {
  return (
    <Badge
      tone={
        ["new", "update"].includes(value)
          ? "blue"
          : ["done", "recorded", "success", "matched"].includes(value)
            ? "green"
            : ["review", "partial", "unmatched", "unknown"].includes(value)
              ? "amber"
              : ["failed", "error"].includes(value)
                ? "red"
                : "neutral"
      }
    >
      {statuses[value] || value}
    </Badge>
  );
}
const titles = {
  import: ["账单工作台", "把零散的消费，整理成清楚的每一笔。"],
  history: ["操作记录", "导入、编辑和新增，每一步都有记录。"],
  data: ["数据管理", "管理导入账单与回收站，数据仅属于当前账号。"],
  accounts: ["账号设置", "管理自己的登录账号，账单与设置独立保存。"],
  settings: ["账本设置", "连接你习惯的账本，保留自己的记账方式。"],
  customization: [
    "账单自定义",
    "过滤不需要的消费，按自己的习惯显示商户和商品。",
  ],
  guide: ["使用教程", "从导出账单到同步飞书，一步一步来。"],
};
type Page = keyof typeof titles;

export default function App() {
  const qc = useQueryClient();
  const [page, setPage] = useState<Page>(() =>
    location.hash.slice(1).split("?")[0] in titles
      ? (location.hash.slice(1).split("?")[0] as Page)
      : "import",
  );
  function navigate(next: Page) {
    if (location.hash !== "#" + next) {
      history.pushState(null, "", "#" + next);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    setPage(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  useEffect(() => {
    const restore = () =>
      setPage(
        location.hash.slice(1).split("?")[0] in titles
          ? (location.hash.slice(1).split("?")[0] as Page)
          : "import",
      );
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, []);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("admin");
  const auth = useQuery({
    queryKey: ["auth"],
    queryFn: () => api("/auth/status"),
  });
  const enabled = !!auth.data?.authenticated;
  const dataQuery = useQuery<LedgerData>({
    queryKey: ["data"],
    queryFn: () => api("/data"),
    enabled,
    refetchInterval: 3000,
  });
  const ledgerQuery = useQuery({
    queryKey: ["ledger"],
    queryFn: () => api("/ledger"),
    enabled,
  });
  const jobsQuery = useQuery<any[]>({
    queryKey: ["jobs"],
    queryFn: () => api("/jobs"),
    enabled,
    refetchInterval: 2000,
  });
  const data = dataQuery.data;
  const jobs = jobsQuery.data || [];
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [refundId, setRefundId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [screenshotFiles, setScreenshotFiles] = useState<File[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [kind, setKind] = useState("expenses");
  const [filter, setFilter] = useState("pending");
  const [sources, setSources] = useState<string[]>([...SOURCES]);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState(() => dateRange("month")[0]);
  const [dateTo, setDateTo] = useState(() => dateRange("month")[1]);
  const [account, setAccount] = useState("默认账户");
  const [jobDetail, setJobDetail] = useState<any>(null);
  const [checkJobId,setCheckJobId] = useState<string|null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [billDeletion, setBillDeletion] = useState<DeletePlan | null>(null);
  async function askDelete(id: string) {
    try {
      setBillDeletion(await deletionPlan("events", [id]));
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  const [dataTab, setDataTab] = useState("imports");
  const [detailTrail, setDetailTrail] = useState<
    { kind: "expense" | "refund"; id: string }[]
  >([]);
  function switchDetail(next: "expense" | "refund", id: string) {
    if (detailId)
      setDetailTrail((t) => [...t, { kind: "expense", id: detailId }]);
    else if (refundId)
      setDetailTrail((t) => [...t, { kind: "refund", id: refundId }]);
    setDetailId(next === "expense" ? id : null);
    setRefundId(next === "refund" ? id : null);
  }
  function backDetail() {
    const previous = detailTrail.at(-1);
    if (!previous) return;
    setDetailTrail((t) => t.slice(0, -1));
    setDetailId(previous.kind === "expense" ? previous.id : null);
    setRefundId(previous.kind === "refund" ? previous.id : null);
  }
  function closeDetails() {
    setDetailId(null);
    setRefundId(null);
    setDetailTrail([]);
  }
  function openOperationEvent(id: string) {
    const expense = data?.expenses.find(
      (e) => e.id === id || e.members.some((m) => m.id === id),
    );
    setDetailTrail([]);
    if (expense) setDetailId(expense.id);
    else if (data?.refunds.some((e) => e.id === id)) setRefundId(id);
    else if (data?.excluded.some((e) => e.id === id)) {
      navigate("import");
      setKind("excluded");
      const record = data?.excluded.find((e) => e.id === id);
      setSources([...SOURCES]);
      setSearch(record?.order_id || record?.merchant || "");
      setDateFrom("");
      setDateTo("");
      notify("该记录属于非消费收支，已打开对应列表");
    } else notify("这笔账单已移入回收站或被清理，请在数据管理中查看", true);
  }
  useEffect(() => {
    const expired = () => {
      qc.clear();
      location.reload();
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [qc]);
  const notify = (text: string, error = false) => setToast({ text, error });
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(
        () => setToast(null),
        toast.error ? 14000 : 7000,
      );
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["data"] });
    await qc.invalidateQueries({ queryKey: ["jobs"] });
    await qc.invalidateQueries({ queryKey: ["ledger"] });
    await qc.invalidateQueries({ queryKey: ["operations"] });
  }
  async function action(path: string, body: any, method = "POST") {
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function upload(files: File[]) {
    if (!files.length) return;
    if (files.length > 10) {
      notify("每批最多 10 个文件，请分批上传", true);
      return;
    }
    setUploading(true);
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("account", account || "默认账户");
    try {
      await api("/imports", { method: "POST", body: fd });
      notify(`已接收 ${files.length} 个文件，正在后台解析`);
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setUploading(false);
    }
  }
  const dropzone = useDropzone({
    onDrop: (files) => {
      const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
      const bills = files.filter((f) => !images.includes(f));
      if (images.length) setScreenshotFiles(images);
      if (bills.length) void upload(bills);
    },
    accept: {
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
        ".xlsx",
      ],
      "application/pdf": [".pdf"],
    },
    maxSize: 20 * 1024 * 1024,
    onDropRejected: () =>
      notify("请上传不超过 20 MB 的账单文件或订单截图", true),
    disabled: uploading,
  });
  const shared = useMemo(() => {
    const matches = (e: {
      platform: string;
      platforms?: string[];
      time: string;
      merchant: string;
      description: string;
      order_id: string;
      category: string;
      sync_description?: string;
    }) =>
      sources.some((p) => (e.platforms || [e.platform]).includes(p)) &&
      (!dateFrom || e.time.slice(0, 10) >= dateFrom) &&
      (!dateTo || e.time.slice(0, 10) <= dateTo) &&
      (!search ||
        [e.merchant, e.description, e.order_id, e.category, e.sync_description]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()));
    return {
      expenses: (data?.expenses || []).filter(matches),
      refunds: (data?.refunds || []).filter(matches),
      excluded: (data?.excluded || []).filter(matches),
    };
  }, [data, sources, dateFrom, dateTo, search]);
  const rows = useMemo(
    () =>
      shared.expenses.filter(
        (e) =>
          filter === "all" ||
          (filter === "pending"
            ? ["new", "update"].includes(e.status)
            : e.status === filter),
      ),
    [shared, filter],
  );
  const availableCount = rows.filter((e) =>
    ["new", "update"].includes(e.status),
  ).length;
  const chosen = (data?.expenses || []).filter(
    (e) => selected[e.id] && ["new", "update"].includes(e.status),
  );
  const newTotal = chosen
    .filter((e) => e.status === "new")
    .reduce((sum, e) => sum + e.net, 0);
  const updateTotal = chosen
    .filter((e) => e.status === "update")
    .reduce((sum, e) => sum + e.net - (e.remote_amount || 0), 0);
  const current = data?.expenses.find((e) => e.id === detailId);
  const refund = data?.refunds.find((e) => e.id === refundId);
  const active = jobs.filter((j) => ["queued", "running"].includes(j.state));
  const columns = useMemo<ColumnDef<Expense>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: () => {
          const available = table
            .getRowModel()
            .rows.filter((r) => ["new", "update"].includes(r.original.status));
          return (
            <input
              type="checkbox"
              aria-label="选择当前页"
              checked={
                available.length > 0 &&
                available.every((r) => selected[r.original.id])
              }
              onChange={(e) =>
                setSelected((s) => {
                  const next = { ...s };
                  available.forEach((r) => {
                    next[r.original.id] = e.target.checked;
                  });
                  return next;
                })
              }
            />
          );
        },
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`选择 ${row.original.merchant || row.original.description}`}
            checked={
              !!selected[row.original.id] &&
              ["new", "update"].includes(row.original.status)
            }
            disabled={!["new", "update"].includes(row.original.status)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setSelected((s) => ({
                ...s,
                [row.original.id]: e.target.checked,
              }))
            }
          />
        ),
      },
      {
        accessorKey: "time",
        header: "交易时间",
        cell: ({ row }) => (
          <div className="date-cell">
            <span>{row.original.time.slice(0, 10)}</span>
            <small>{row.original.time.slice(11)}</small>
          </div>
        ),
      },
      {
        id: "merchant",
        header: "商户 / 商品",
        cell: ({ row }) => (
          <div className="merchant-cell">
            <span
              className={"merchant-icon " + sourceClass[row.original.platform]}
            >
              <Wallet size={16} />
            </span>
            <div>
              <strong>
                {row.original.merchant ||
                  row.original.description ||
                  "未命名交易"}
              </strong>
              <small>
                {row.original.mapped_description ||
                  (row.original.display_rule
                    ? row.original.sync_description
                    : row.original.description) ||
                  row.original.category ||
                  "点击查看原始明细"}
              </small>
            </div>
          </div>
        ),
      },
      {
        id: "source",
        header: "来源",
        cell: ({ row }) => (
          <div className="source-stack">
            {row.original.platforms.map((p) => (
              <Source key={p} name={p} />
            ))}
          </div>
        ),
      },
      {
        accessorKey: "amount",
        header: () => <span className="number">原付</span>,
        cell: ({ row }) => (
          <span className="number muted">{money(row.original.amount)}</span>
        ),
      },
      {
        accessorKey: "refund",
        header: () => <span className="number">已退</span>,
        cell: ({ row }) => (
          <span
            className={
              "number " + (row.original.refund ? "refund-number" : "muted")
            }
          >
            {row.original.refund ? "−" + money(row.original.refund) : "—"}
          </span>
        ),
      },
      {
        accessorKey: "net",
        header: () => <span className="number">净支出</span>,
        cell: ({ row }) => (
          <strong className="number net-number">
            {money(row.original.net)}
          </strong>
        ),
      },
      {
        accessorKey: "status",
        header: "处理状态",
        cell: ({ row }) => <Status value={row.original.status} />,
      },
      {
        id: "detail",
        header: "",
        cell: () => <ChevronRight size={16} className="muted" />,
      },
    ],
    [selected],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      pagination: { pageSize: 15 },
      sorting: [{ id: "time", desc: true }],
    },
  });
  async function prepare() {
    setBusy(true);
    try {
      const result = await api("/sync/preview", {
        method: "POST",
        body: JSON.stringify({ ids: chosen.map((e) => e.id) }),
      });
      setPreview(result);
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    setBusy(true);
    try {
      await api("/sync/jobs", {
        method: "POST",
        body: JSON.stringify({
          preview_id: preview.id,
          revision: preview.revision || 0,
        }),
      });
      setPreview(null);
      setSelected({});
      navigate("history");
      notify("同步任务已提交，可在这里查看每笔结果");
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const pageTitle =
    page === "accounts" && auth.data?.user?.role === "admin"
      ? "账号管理"
      : titles[page][0];
  if (auth.isLoading)
    return (
      <div className="login-screen">
        <Loader2 className="spin" />
      </div>
    );
  if (!enabled)
    return (
      <div className="login-screen">
        <form
          className="card login-card"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/auth/login", {
                method: "POST",
                body: JSON.stringify({ username, password }),
              });
              await qc.invalidateQueries({ queryKey: ["auth"] });
            } catch (err) {
              notify((err as Error).message, true);
            }
          }}
        >
          <span className="brand-mark">
            <FileSpreadsheet size={25} />
          </span>
          <h1>账单整理</h1>
          <p>登录你的私人账单工作台</p>
          <label className="field">
            账号名
            <input
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={40}
            />
          </label>
          <label className="field">
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <Button type="submit">
            登录 <ArrowRight size={16} />
          </Button>
          {toast && (
            <p role="alert" className="error-text">
              {toast.text}
            </p>
          )}
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("import");
          }}
          className="brand"
        >
          <span className="brand-mark">
            <FileSpreadsheet size={23} />
          </span>
          <div>
            <strong>账单整理</strong>
            <small>让每一笔，都清楚</small>
          </div>
        </a>
        <nav>
          {(
            [
              ["import", LayoutGrid, "账单工作台"],
              ["customization", Sparkles, "账单自定义"],
              ["history", History, "操作记录"],
              ["data", Database, "数据管理"],
              ["accounts", Users, "账号设置"],
              ["settings", Settings2, "账本设置"],
              ["guide", BookOpen, "使用教程"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              className={page === key ? "nav-item active" : "nav-item"}
              title={
                key === "accounts" && auth.data.user?.role === "admin"
                  ? "账号管理"
                  : label
              }
              aria-label={
                key === "accounts" && auth.data.user?.role === "admin"
                  ? "账号管理"
                  : label
              }
              onClick={() => navigate(key)}
            >
              <Icon size={18} />
              {key === "accounts" && auth.data.user?.role === "admin"
                ? "账号管理"
                : label}
              {key === "history" && active.length > 0 && (
                <span className="nav-count">{active.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-label">
            <ShieldCheck size={17} />
            <span>
              私有账单空间<small>数据保存在自己的服务器</small>
            </span>
          </div>
          {enabled && (
            <button
              className="nav-item"
              onClick={async () => {
                await api("/auth/logout", { method: "POST" });
                qc.clear();
                location.reload();
              }}
            >
              <LogOut size={16} />
              退出登录
            </button>
          )}
          <span className="version">个人记账助手 · v0.1</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <nav className="breadcrumb" aria-label="面包屑导航">
            <button onClick={() => navigate("import")}>我的工作台</button>
            <ChevronRight size={13} />
            <button aria-current="page" onClick={() => navigate(page)}>
              {pageTitle}
            </button>
          </nav>
          <div className="topbar-right">
            <span className="local-pill">
              <i />
              {auth.data.user?.username}
            </span>
            <span className="avatar" title={auth.data.user?.username}>
              {auth.data.user?.username?.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>{pageTitle}</h1>
              {(page === "import" || page === "guide") && (
                <p>{titles[page][1]}</p>
              )}
            </div>
            {page === "import" && (
              <div className="heading-actions">
                <Button variant="outline" onClick={() => navigate("guide")}>
                  <BookOpen size={15} />
                  使用教程 <ArrowUpRight size={14} />
                </Button>
              </div>
            )}
          </div>
          {page === "data" ? (
            <DataManagement
              openExpense={openOperationEvent}
              initialTab={dataTab}
              notify={notify}
              onChanged={async () => {
                setSelected({});
                setPreview(null);
                closeDetails();
                await refresh();
              }}
            />
          ) : page === "accounts" ? (
            <Accounts user={auth.data.user} notify={notify} />
          ) : page === "customization" ? (
            <Customization notify={notify} />
          ) : page === "settings" ? (
            <Settings notify={notify} />
          ) : page === "guide" ? (
            <Guide />
          ) : page === "history" ? (
            <Activity
              jobs={jobs}
              details={setJobDetail}
              retry={(id) => setCheckJobId(id)}
              openExpense={openOperationEvent}
              openData={(tab) => {
                setDataTab(tab);
                navigate("data");
              }}
              renderStatus={(value) => <Status value={value} />}
            />
          ) : (
            <>
              <DouyinScreenshots files={screenshotFiles} close={() => setScreenshotFiles(null)} done={refresh} notify={notify} />
              <section className="upload-layout">
                <div
                  className={
                    "card dropzone " +
                    (dropzone.isDragActive ? "drag-active" : "")
                  }
                  {...dropzone.getRootProps()}
                >
                  <input
                    {...dropzone.getInputProps()}
                    aria-label="上传账单文件"
                  />
                  <div className="upload-icon">
                    {uploading ? (
                      <Loader2 size={28} className="spin" />
                    ) : (
                      <UploadCloud size={29} strokeWidth={1.6} />
                    )}
                  </div>
                  <h2>
                    {dropzone.isDragActive
                      ? "松开，开始整理账单"
                      : "把账单拖到这里"}
                  </h2>
                  <p>
                    或 <span>选择文件</span>
                  </p>
                  <div className="supported-sources">
                    {["微信", "支付宝", "京东", "美团", "抖音"].map((p) => (
                      <Source name={p} key={p} />
                    ))}
                  </div>
                  <small>账单 CSV / XLSX / PDF · 抖音订单截图 JPG / PNG / WEBP</small>
                </div>
                <aside className="ledger-card">
                  <div className="flex-between">
                    <span className="icon-box">
                      <Wallet size={20} />
                    </span>
                    <Badge
                      tone={ledgerQuery.data?.checked_at ? "green" : "neutral"}
                    >
                      {ledgerQuery.data?.checked_at ? "读取已验证" : "尚未连接"}
                    </Badge>
                  </div>
                  <h3>你的飞书账本</h3>
                  <p>
                    {ledgerQuery.data?.checked_at
                      ? `已核对全表 ${ledgerQuery.data.read_count || 0} 条记录，可以继续选择消费。`
                      : "连接飞书，按需同步消费。"}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigate("settings")}
                  >
                    <Link2 size={15} />
                    {ledgerQuery.data?.checked_at
                      ? "查看账本配置"
                      : "连接我的账本"}
                    <ArrowRight size={15} />
                  </Button>
                </aside>
              </section>
              <div className="account-row">
                <label>
                  支付账户别名{" "}
                  <input
                    aria-label="支付账户别名"
                    value={account}
                    maxLength={80}
                    onChange={(e) => setAccount(e.target.value)}
                  />
                </label>
                <span title="同一人的重叠账期请沿用相同别名，不同人的账单请分开导入。">
                  重叠账期使用同一别名
                </span>
              </div>
              {active.length > 0 && (
                <div className="notice">
                  <Loader2 size={17} className="spin" />
                  <span>
                    正在后台处理 {active.length} 个任务，完成后列表会自动更新。
                    <button onClick={() => navigate("history")}>
                      查看进度
                    </button>
                  </span>
                </div>
              )}
              {jobs
                .filter((j) => j.kind === "import" && j.state === "partial")
                .slice(0, 1)
                .map((j) => (
                  <div key={j.id} className="notice warning">
                    <CircleAlert size={18} />
                    <span>
                      最近一次导入存在异常，部分文件或行未被计入。
                      <button
                        onClick={() => {
                          navigate("history");
                          setJobDetail(j);
                        }}
                      >
                        查看具体原因
                      </button>
                    </span>
                  </div>
                ))}
              <section className="stats-grid">
                {[
                  {
                    label: "待新增支出",
                    value: data?.summary.new || 0,
                    Icon: Plus,
                    color: "blue",
                    text: "核对完成，即可选择同步",
                  },
                  {
                    label: "待更新记录",
                    value: data?.summary.update || 0,
                    Icon: RefreshCw,
                    color: "mint",
                    text: "修正退款金额或显示内容",
                  },
                  {
                    label: "已经记录",
                    value: data?.summary.recorded || 0,
                    Icon: FileCheck2,
                    color: "gray",
                    text: data?.remote_checked
                      ? "自动跳过，不重复记账"
                      : "连接飞书后核对既有记录",
                  },
                  {
                    label: "需要你确认",
                    value:
                      (data?.summary.review || 0) +
                      (data?.refunds.filter((r) => r.status === "unmatched")
                        .length || 0),
                    Icon: CircleAlert,
                    color: "amber",
                    text: "查看重复候选与退款归属",
                  },
                ].map((s) => (
                  <div className="card stat-card" key={s.label}>
                    <div className="flex-between">
                      <span>{s.label}</span>
                      <span className={"stat-icon " + s.color}>
                        <s.Icon size={17} />
                      </span>
                    </div>
                    <strong>
                      {s.value}
                      <small>笔</small>
                    </strong>
                  </div>
                ))}
              </section>
              <section className="card bill-section">
                <div className="bill-heading">
                  <div>
                    <h2>账单明细</h2>
                  </div>
                  <div className="bill-tools">
                    <Button size="sm" onClick={() => setManualOpen(true)}>
                      <Plus size={14} />
                      添加账单
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={refresh}
                      aria-label="刷新账单"
                    >
                      <RefreshCw size={15} />
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href="/api/export">
                        <ArrowDownToLine size={14} />
                        导出整理结果
                      </a>
                    </Button>
                  </div>
                </div>
                <SharedFilters
                  sources={sources}
                  onSources={setSources}
                  from={dateFrom}
                  to={dateTo}
                  onFrom={setDateFrom}
                  onTo={setDateTo}
                  search={search}
                  onSearch={setSearch}
                />
                <div className="kind-tabs">
                  {[
                    ["expenses", "消费支出", shared.expenses.length],
                    ["refunds", "退款核对", shared.refunds.length],
                    ["excluded", "非消费记录", shared.excluded.length],
                  ].map(([key, label, count]) => (
                    <button
                      key={key}
                      className={kind === key ? "active" : ""}
                      onClick={() => setKind(String(key))}
                    >
                      {label}
                      <span>{count || 0}</span>
                    </button>
                  ))}
                </div>
                {dataQuery.isError && (
                  <div className="notice warning">
                    <CircleAlert size={16} />
                    无法读取账单数据，请确认后端已启动。
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => dataQuery.refetch()}
                    >
                      重试
                    </Button>
                  </div>
                )}
                {kind === "expenses" ? (
                  <>
                    <div className="table-toolbar">
                      <div className="filter-tabs">
                        {[
                          ["pending", "待同步"],
                          ["review", "待确认"],
                          ["recorded", "已记录"],
                          ["refunded", "全额退款"],
                          ["filtered", "已过滤"],
                          ["excluded", "已排除"],
                          ["all", "全部"],
                        ].map(([key, label]) => (
                          <button
                            key={key}
                            onClick={() => setFilter(key)}
                            className={filter === key ? "active" : ""}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="selection-toolbar">
                      <span className="available-count">
                        可同步 <strong>{availableCount}</strong> 笔
                      </span>
                      <div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!availableCount}
                          title="选择当前筛选中的可同步记录"
                          onClick={() =>
                            setSelected((previous) => ({
                              ...previous,
                              ...Object.fromEntries(
                                rows
                                  .filter((e) =>
                                    ["new", "update"].includes(e.status),
                                  )
                                  .map((e) => [e.id, true]),
                              ),
                            }))
                          }
                        >
                          <CheckCheck size={15} />
                          全部选择
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!chosen.length}
                          onClick={() => setSelected({})}
                        >
                          <X size={15} />
                          清除选择
                        </Button>
                      </div>
                    </div>
                    {rows.length > 0 ? (
                      <>
                        <div className="table-scroll">
                          <table className="expense-table">
                            <thead>
                              {table.getHeaderGroups().map((hg) => (
                                <tr key={hg.id}>
                                  {hg.headers.map((h) => (
                                    <th key={h.id}>
                                      {h.column.getCanSort() ? (
                                        <button
                                          className="sort-header"
                                          onClick={h.column.getToggleSortingHandler()}
                                        >
                                          {flexRender(
                                            h.column.columnDef.header,
                                            h.getContext(),
                                          )}
                                          <span>
                                            {h.column.getIsSorted() === "desc"
                                              ? "↓"
                                              : h.column.getIsSorted() === "asc"
                                                ? "↑"
                                                : "↕"}
                                          </span>
                                        </button>
                                      ) : (
                                        flexRender(
                                          h.column.columnDef.header,
                                          h.getContext(),
                                        )
                                      )}
                                    </th>
                                  ))}
                                </tr>
                              ))}
                            </thead>
                            <tbody>
                              {table.getRowModel().rows.map((r) => (
                                <tr
                                  key={r.id}
                                  onClick={() => setDetailId(r.original.id)}
                                  className={
                                    selected[r.original.id] &&
                                    ["new", "update"].includes(
                                      r.original.status,
                                    )
                                      ? "selected-row"
                                      : ""
                                  }
                                >
                                  {r.getVisibleCells().map((c) => (
                                    <td key={c.id}>
                                      {flexRender(
                                        c.column.columnDef.cell,
                                        c.getContext(),
                                      )}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="table-pagination">
                          <span>
                            共 {rows.length} 笔 · 已解析{" "}
                            {data?.files.length || 0} 个文件
                          </span>
                          <div>
                            <span>
                              第 {table.getState().pagination.pageIndex + 1} /{" "}
                              {Math.max(1, table.getPageCount())} 页
                            </span>
                            <Button
                              size="icon"
                              variant="outline"
                              disabled={!table.getCanPreviousPage()}
                              onClick={() => table.previousPage()}
                              aria-label="上一页"
                            >
                              <ChevronLeft size={15} />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              disabled={!table.getCanNextPage()}
                              onClick={() => table.nextPage()}
                              aria-label="下一页"
                            >
                              <ChevronRight size={15} />
                            </Button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <Empty
                        title={
                          data?.files.length
                            ? "这里暂时没有符合条件的记录"
                            : "准备好第一份账单了吗？"
                        }
                        text={
                          data?.files.length
                            ? "试试其他筛选，或到退款核对里确认归属。"
                            : "上传账单后，这里会自动整理出你的消费支出。"
                        }
                      />
                    )}
                  </>
                ) : kind === "refunds" ? (
                  <div className="refund-list">
                    {!shared.refunds.length ? (
                      <Empty
                        title={
                          data?.refunds.length
                            ? "没有符合筛选的退款"
                            : "还没有退款记录"
                        }
                        text="文件中的退款会保留在这里，用于修正原消费金额。"
                      />
                    ) : (
                      shared.refunds.map((r) => (
                        <button
                          key={r.id}
                          className="refund-row"
                          onClick={() => setRefundId(r.id)}
                        >
                          <span className="refund-icon">
                            <RefreshCw size={17} />
                          </span>
                          <div>
                            <strong>{r.merchant || r.description}</strong>
                            <small>
                              {r.time} · {r.basis}
                            </small>
                          </div>
                          <Source name={r.platform} />
                          <strong className="refund-number">
                            {money(r.amount)}
                          </strong>
                          <Status value={r.status} />
                          <ChevronRight size={15} />
                        </button>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="excluded-list">
                    {!shared.excluded.length ? (
                      <Empty
                        title={
                          data?.excluded.length
                            ? "没有符合筛选的非消费记录"
                            : "暂无非消费记录"
                        }
                        text="收入、还款和资金流转将在这里展示排除原因。"
                      />
                    ) : (
                      shared.excluded.map((e) => (
                        <div className="excluded-row" key={e.id}>
                          <FileText size={17} />
                          <div>
                            <strong>
                              {e.merchant ||
                                e.description ||
                                e.category ||
                                "资金记录"}
                            </strong>
                            <small>
                              {e.time} · {e.reason}
                            </small>
                          </div>
                          <Source name={e.platform} />
                          <span>{money(e.amount)}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>
              <div className="sync-bar">
                <div className="sync-summary">
                  <div className="sync-metric">
                    <span>已选择</span>
                    <strong>
                      {chosen.length}
                      <small>笔</small>
                    </strong>
                  </div>
                  <div className="sync-metric">
                    <span>新增支出</span>
                    <strong>{money(newTotal)}</strong>
                  </div>
                  {updateTotal !== 0 && (
                    <span className="sync-change">
                      原支出修正 {money(updateTotal)}
                    </span>
                  )}
                </div>
                <div>
                  {!ledgerQuery.data?.checked_at && (
                    <button
                      className="connect-link"
                      onClick={() => navigate("settings")}
                    >
                      先连接飞书账本 <ArrowUpRight size={13} />
                    </button>
                  )}
                  <Button
                    onClick={prepare}
                    disabled={
                      !chosen.length ||
                      busy ||
                      !ledgerQuery.data?.checked_at ||
                      active.some((j) => j.kind === "sync")
                    }
                  >
                    {busy ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                    同步预览 {chosen.length > 0 && `(${chosen.length})`}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {toast && (
        <div
          role="alert"
          className={"toast " + (toast.error ? "toast-error" : "")}
        >
          {toast.error ? <CircleAlert size={19} /> : <Check size={19} />}
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title="确认本次同步"
        description="逐笔核对新增与退款修正，提交后在操作记录查看结果。"
        wide
      >
        {preview && (
          <>
            <div className="preview-summary">
              <span>
                新增{" "}
                {preview.items.filter((i: any) => i.action === "create").length}{" "}
                笔
              </span>
              <span>
                更新{" "}
                {preview.items.filter((i: any) => i.action === "update").length}{" "}
                笔
              </span>
              <span>已记录或不可写跳过 {preview.skipped.length} 笔</span>
            </div>
            <SyncPreviewItems
              preview={preview}
              expenses={data?.expenses || []}
              onChange={setPreview}
              notify={notify}
              onRefresh={refresh}
            />
            <div className="notice small">
              本次只写上述记录。退款更新归回原消费日期；同步键用于防止重复新增。
            </div>
            <div className="modal-actions">
              <Button variant="outline" onClick={() => setPreview(null)}>
                继续核对
              </Button>
              <Button
                onClick={sync}
                disabled={
                  busy ||
                  !preview.items.length ||
                  !!preview.setup_warnings?.length
                }
              >
                {busy && <Loader2 size={16} className="spin" />}确认同步
              </Button>
            </div>
          </>
        )}
      </Modal>
      <Modal open={!!current} onClose={closeDetails} title="消费明细" sheet>
        {current && (
          <>
            {!!detailTrail.length && (
              <Button
                variant="outline"
                size="sm"
                className="detail-back"
                onClick={backDetail}
              >
                <ChevronLeft size={14} />
                {detailTrail.at(-1)?.kind === "refund"
                  ? "返回退款详情"
                  : "返回消费明细"}
              </Button>
            )}
            <Detail
              key={current.id}
              expense={current}
              action={action}
              close={closeDetails}
              openRefund={(id) => switchDetail("refund", id)}
              deleteBill={() => askDelete(current.id)}
              reviewRefunds={() => {
                closeDetails();
                setKind("refunds");
              }}
              editRules={() => {
                closeDetails();
                navigate("customization");
              }}
            />
          </>
        )}
      </Modal>
      <Modal
        open={!!refund}
        onClose={closeDetails}
        title="退款归属"
        description="只有确认的退款才会修正原消费"
        sheet
      >
        {refund && (
          <>
            {!!detailTrail.length && (
              <Button
                variant="outline"
                size="sm"
                className="detail-back"
                onClick={backDetail}
              >
                <ChevronLeft size={14} />
                {detailTrail.at(-1)?.kind === "refund"
                  ? "返回退款详情"
                  : "返回消费明细"}
              </Button>
            )}
            <RefundDetail
              key={refund.id}
              refund={refund}
              expenses={data?.expenses || []}
              action={action}
              openOriginal={(id) => switchDetail("expense", id)}
              deleteBill={() => askDelete(refund.id)}
            />
          </>
        )}
      </Modal>
      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="手动录入账单"
        sheet
      >
        {manualOpen && (
          <ManualExpense
            notify={notify}
            onSaved={async (id, keepOpen) => {
              if (keepOpen) {
                await refresh();
                notify("账单已保存，可以继续添加");
                return;
              }
              setManualOpen(false);
              await refresh();
              navigate("import");
              setKind("expenses");
              setFilter("all");
              setSources([...SOURCES]);
              setDateFrom("");
              setDateTo("");
              setSearch("");
              setDetailId(id);
              notify("账单已保存，可选择同步");
            }}
          />
        )}
      </Modal>
      <DeleteBillDialog
        plan={billDeletion}
        onClose={() => setBillDeletion(null)}
        notify={notify}
        onDone={async () => {
          closeDetails();
          setSelected({});
          setPreview(null);
          await refresh();
          await qc.invalidateQueries({ queryKey: ["data-management"] });
          await qc.invalidateQueries({ queryKey: ["trash"] });
        }}
      />
      {checkJobId&&<SyncCheck key={checkJobId} jobId={checkJobId} close={()=>setCheckJobId(null)} refresh={refresh} notify={notify}/>}
      <Modal
        open={!!jobDetail}
        onClose={() => setJobDetail(null)}
        title="处理详情"
        wide
      >
        {jobDetail && (
          <JobDetail
            job={jobs.find((j) => j.id === jobDetail.id) || jobDetail}
          />
        )}
      </Modal>
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <div>
        <Inbox size={30} strokeWidth={1.2} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      <span>清楚记账，从一份账单开始</span>
    </div>
  );
}
function Detail({
  expense: e,
  action,
  close,
  reviewRefunds,
  editRules,
  openRefund,
  deleteBill,
}: {
  expense: Expense;
  action: (path: string, body: any, method?: string) => Promise<void>;
  close: () => void;
  reviewRefunds: () => void;
  editRules: () => void;
  openRefund: (id: string) => void;
  deleteBill: () => void;
}) {
  const [category, setCategory] = useState(e.category);
  const [note, setNote] = useState(e.note);
  return (
    <div className="detail-body">
      <div className="detail-hero">
        <Status value={e.status} />
        <h2>{e.merchant || e.description}</h2>
        <p>{e.description}</p>
        <strong>{money(e.net)}</strong>
        <span>
          {e.status === "review" ? "暂算净额 · 核对后才能同步" : "实际支出"}
        </span>
      </div>
      <div className="amount-equation">
        <div>
          原付<strong>{money(e.amount)}</strong>
        </div>
        <span>−</span>
        <div>
          已确认退款<strong>{money(e.refund)}</strong>
        </div>
        <span>=</span>
        <div>
          净支出<strong>{money(e.net)}</strong>
        </div>
      </div>
      {e.reasons.map((r) => (
        <div className="notice warning small" key={r}>
          <CircleAlert size={15} />
          {r}
        </div>
      ))}
      {e.status === "filtered" && (
        <div className="detail-actions">
          <Button
            onClick={() =>
              action("/events/" + e.id, { filter_exempt: true }, "PATCH")
            }
          >
            仅此笔取消过滤
          </Button>
          <Button variant="outline" onClick={editRules}>
            调整账单过滤规则
          </Button>
        </div>
      )}
      {e.filter_exempt && (
        <div className="notice small">
          此笔已取消规则过滤。
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              action("/events/" + e.id, { filter_exempt: false }, "PATCH")
            }
          >
            恢复规则过滤
          </Button>
        </div>
      )}
      {e.douyin_duplicate && <div className="display-evidence"><span>抖音月付重复流水核对</span><strong>{e.douyin_duplicate.original_time} · {e.douyin_duplicate.original_order || "多笔可能原单"}</strong><small>{e.douyin_duplicate.basis}</small>{e.douyin_duplicate_exempt && <><small>此笔已单独恢复，当前不应用重复排除规则。</small><Button size="sm" variant="outline" onClick={()=>action("/events/"+e.id,{douyin_duplicate_exempt:false},"PATCH")}>重新应用重复排除规则</Button></>}</div>}
      {e.douyin_order_info && <div className="display-evidence"><span>截图补充 · {e.douyin_order_info.image_name} · 第 {e.douyin_order_info.position} 笔</span><strong>{e.merchant} / {e.description}</strong><small>原始账单保留在下方来源记录。可重新上传截图修改，或移除补充内容。</small><Button variant="outline" size="sm" onClick={() => { if (window.confirm("确定移除此笔截图补充的商户和商品信息吗？")) void action("/douyin-screenshots/enrichment/" + e.douyin_order_info!.event_id, {}, "DELETE"); }}>移除补充</Button></div>}
      {e.display_rule && (
        <div className="display-evidence">
          <span>飞书显示内容 · {e.display_rule}</span>
          <strong>{e.sync_description}</strong>
          <small>原始商户和商品保留在下方来源记录中。</small>
        </div>
      )}
      {e.status === "update" && (
        <div className="notice">
          {e.update_reason === "显示内容更新" ? (
            "显示内容已调整，在主列表勾选后更新飞书原记录。"
          ) : (
            <>
              飞书原支出 {money(e.remote_amount || 0)} → 本次净支出{" "}
              {money(e.net)}
              ，在主列表勾选后同步。
            </>
          )}
        </div>
      )}
      {e.record_id &&
        e.status === "review" &&
        e.reasons.some((r) => r.includes("手动修改")) && (
          <Button
            variant="outline"
            onClick={() =>
              action("/bind", { event_id: e.id, record_id: e.record_id })
            }
          >
            已核对，允许更新原记录
          </Button>
        )}
      {e.reasons.some((r) => r.includes("原飞书记录已删除")) && (
        <Button
          variant="outline"
          onClick={() => action("/unbind", { event_id: e.id })}
        >
          确认原记录已移除，解除绑定后重新核对
        </Button>
      )}
      <dl className="detail-meta">
        <div>
          <dt>交易时间</dt>
          <dd>{e.time}</dd>
        </div>
        <div>
          <dt>支付方式</dt>
          <dd>{e.method || "未提供"}</dd>
        </div>
        <div>
          <dt>交易单号</dt>
          <dd>{e.order_id || "缺失"}</dd>
        </div>
      </dl>
      <h3>原始来源 · {e.members.length} 条</h3>
      {e.members.map((m) => (
        <div key={m.id} className="evidence">
          <Source name={m.platform} />
          <strong>{m.state || m.direction}</strong>
          <small>
            {m.file_name} · {m.location}
          </small>
          <small>
            {m.merchant} · {m.description || "未提供商品"}
          </small>
          <code>{m.order_id}</code>
          {m.id !== e.id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                action("/events/" + m.id, { merge_into: "" }, "PATCH")
              }
            >
              解除合并
            </Button>
          )}
        </div>
      ))}
      <h3>已关联退款 · {e.refunds.length} 条</h3>
      {e.refunds.map((r) => (
        <div className="evidence" key={r.id}>
          <Source name={r.platform} />
          <strong>{money(r.amount)}</strong>
          <Button size="sm" variant="outline" onClick={() => openRefund(r.id)}>
            查看退款详情
          </Button>
          <small>
            {r.time} · {r.location}
          </small>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              action(
                "/events/" + r.id,
                { refund_to: "", ignore: true },
                "PATCH",
              )
            }
          >
            排除此退款
          </Button>
        </div>
      ))}
      {!e.refunds.length && (
        <p className="muted">
          {e.refund
            ? "依据原支付行的累计退款状态计算。独立流水不会再次扣减。"
            : "暂未关联独立退款流水。"}
        </p>
      )}
      {e.suspects.map((s) => (
        <div className="candidate" key={s.id}>
          <strong>
            疑似同笔：{s.platform} · {s.merchant}
          </strong>
          <small>{s.time}</small>
          <div>
            <Button
              size="sm"
              onClick={() =>
                action("/events/" + s.id, { merge_into: e.id }, "PATCH")
              }
            >
              合并为一笔
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => action("/distinct", { a: e.id, b: s.id })}
            >
              分别保留
            </Button>
          </div>
        </div>
      ))}
      {e.existing_candidates.map((r) => (
        <div className="candidate" key={r.id}>
          <strong>飞书已有记录：{r.description || r.id}</strong>
          <small>
            {r.date?.slice(0, 10)} ·{" "}
            {r.amount == null ? "金额不可读" : money(r.amount)}
          </small>
          <Button
            size="sm"
            onClick={() => action("/bind", { event_id: e.id, record_id: r.id })}
          >
            确认是这笔，绑定原记录
          </Button>
        </div>
      ))}
      {e.existing_candidates.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            action("/events/" + e.id, { distinct_remote: true }, "PATCH")
          }
        >
          不是这些记录，保留为新消费
        </Button>
      )}
      <label className="field">
        分类
        <input
          value={category}
          onChange={(x) => setCategory(x.target.value)}
          maxLength={80}
        />
      </label>
      <label className="field">
        备注
        <textarea
          value={note}
          onChange={(x) => setNote(x.target.value)}
          maxLength={2000}
          rows={3}
        />
      </label>
      <div className="detail-actions">
        <Button
          onClick={async () => {
            await action("/events/" + e.id, { category, note }, "PATCH");
          }}
        >
          保存分类与备注
        </Button>
        {e.status === "review" &&
          e.reasons.some((r) => r.includes("转账、充值")) && (
            <Button
              variant="outline"
              onClick={() =>
                action("/events/" + e.id, { confirmed: true }, "PATCH")
              }
            >
              确认计入消费
            </Button>
          )}
        {e.reasons.some((r) => r.includes("待匹配退款")) && (
          <Button variant="outline" onClick={reviewRefunds}>
            去核对退款归属
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            await action(
              "/events/" + e.id,
              { ignore: e.status !== "excluded", ...(e.automatic_exclusion === "douyin_duplicate" ? {douyin_duplicate_exempt:true} : {}) },
              "PATCH",
            );
            close();
          }}
        >
          {e.status === "excluded" ? "恢复记录" : "排除此消费"}
        </Button>
        <Button variant="danger" onClick={deleteBill}>
          删除账单
        </Button>
      </div>
    </div>
  );
}
function RefundDetail({
  refund: r,
  expenses,
  action,
  openOriginal,
  deleteBill,
}: {
  refund: Refund;
  expenses: Expense[];
  openOriginal: (id: string) => void;
  deleteBill: () => void;
  action: (path: string, body: any, method?: string) => Promise<void>;
}) {
  const [cash, setCash] = useState((r.amount / 100).toFixed(2));
  const [reason, setReason] = useState(r.refund_adjustment_reason || "");
  const [originalOrder, setOriginalOrder] = useState(
    r.refund_original_order || "",
  );
  useEffect(() => {
    setCash((r.amount / 100).toFixed(2));
    setReason(r.refund_adjustment_reason || "");
    setOriginalOrder(r.refund_original_order || "");
  }, [r.id, r.amount, r.refund_adjustment_reason, r.refund_original_order]);
  const [target, setTarget] = useState(r.target || "");
  const [search, setSearch] = useState("");
  const [crossSource, setCrossSource] = useState(false);
  const available = expenses.filter(
    (e) =>
      (crossSource || e.platforms.includes(r.platform)) &&
      e.time <= r.time &&
      e.amount >= r.amount &&
      (e.merchant + e.description + e.order_id).includes(search),
  );
  return (
    <div className="detail-body">
      <div className="detail-hero">
        <Source name={r.platform} />
        <h2>{r.merchant || r.description || "退款"}</h2>
        <strong>{money(r.amount)}</strong>
        <p>{r.time}</p>
        <Status value={r.status} />
      </div>
      <div className="notice small">{r.basis}</div>
      <div className="evidence">
        <small>
          {r.file_name} · {r.location}
        </small>
        <code>{r.order_id}</code>
      </div>
      <section className="refund-cash-adjustment">
        <h3>实际退款金额</h3>
        <p>
          流水金额 {money(r.statement_amount ?? r.amount)}
          {r.refund_adjusted ? ` · 已按实际退款修正为 ${money(r.amount)}` : ""}
        </p>
        <p className="muted">
          仅填写实际到账或减免还款的金额；优惠扣回、失效／退回的券、会员费不计入本笔退款。不凭流水总额自动拆分。
        </p>
        <label className="field">
          实际退回金额（元）
          <input
            aria-label="实际退回金额"
            type="number"
            min="0"
            step="0.01"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
          />
        </label>
        <label className="field">
          修正依据
          <input
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：账单17.90，扣回支付优惠7.85，实际减免10.05"
          />
        </label>
        <label className="field">
          原商品订单号（可选）
          <input
            maxLength={120}
            value={originalOrder}
            onChange={(e) => setOriginalOrder(e.target.value)}
          />
        </label>
        <div className="detail-actions">
          <Button
            disabled={!/^\d+(\.\d{1,2})?$/.test(cash) || !reason.trim()}
            onClick={() =>
              action(
                "/events/" + r.id,
                {
                  refund_cash_amount: Math.round(Number(cash) * 100),
                  refund_adjustment_reason: reason,
                  refund_original_order: originalOrder,
                },
                "PATCH",
              )
            }
          >
            保存实际退款
          </Button>
          {r.refund_adjusted && (
            <Button
              variant="outline"
              onClick={() =>
                action("/events/" + r.id, { reset_refund_cash: true }, "PATCH")
              }
            >
              恢复流水金额
            </Button>
          )}
        </div>
      </section>
      {r.status === "matched" && r.target && (
        <div className="linked-order">
          <span>已关联原订单</span>
          <code>
            {expenses.find((e) => e.id === r.target)?.order_id || r.target}
          </code>
          <Button variant="outline" onClick={() => openOriginal(r.target!)}>
            查看关联订单详情 <ChevronRight size={14} />
          </Button>
        </div>
      )}
      {r.status !== "matched" && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={crossSource}
              onChange={(e) => setCrossSource(e.target.checked)}
            />
            扩大到其他平台的原消费
          </label>
          <label className="field">
            搜索原消费
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="商户、商品、原订单号"
            />
          </label>
          <label className="field">
            选择原交易
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">请选择，不凭同额直接确认</option>
              {available.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.time.slice(0, 10)} · {e.merchant || e.description} ·{" "}
                  {money(e.amount)} · {e.platform}
                </option>
              ))}
            </select>
          </label>
          {!available.length && (
            <p className="muted">
              没有候选原单，请上传更早的账单。不会创建孤立负支出。
            </p>
          )}
          <Button
            disabled={!target}
            onClick={() =>
              action(
                "/events/" + r.id,
                { refund_to: target, ignore: false },
                "PATCH",
              )
            }
          >
            确认关联原单
          </Button>
        </>
      )}
      <Button
        className="mt-4"
        variant="outline"
        onClick={() =>
          action(
            "/events/" + r.id,
            { ignore: r.status !== "ignored", refund_to: "" },
            "PATCH",
          )
        }
      >
        {r.status === "ignored" ? "恢复退款核对" : "排除此退款"}
      </Button>
      <Button className="mt-4" variant="danger" onClick={deleteBill}>
        删除账单
      </Button>
    </div>
  );
}
function JobDetail({ job: j }: { job: any }) {
  return (
    <div className="job-details">
      <Status value={j.state} />
      {j.error && <div className="notice warning">{j.error}</div>}
      {j.kind === "import" && (
        <div className="dedup-explanation">
          先用 SHA-256
          判断同账户的原文件是否重复；文件不同时，再按来源、账户和交易编号逐笔去重。重叠部分跳过，新交易加入，已有交易的状态变化更新原记录。缺少编号或跨平台疑似重复的记录需人工核对。
        </div>
      )}
      {j.kind === "import" ? (
        j.files?.map((f: any, i: number) => (
          <div className="job-file" key={i}>
            <div className="flex-between">
              <strong>{f.name}</strong>
              <Status value={f.state} />
            </div>
            {f.error && <p className="error-text">{f.error}</p>}
            {f.result && (
              <>
                <p>
                  {f.result.platform} · {f.result.row_count} 个原始事件 ·{" "}
                  {f.result.encoding || "原始文档格式"}
                </p>
                {f.state === "duplicate" && (
                  <p>整文件重复：账户与原文件字节指纹一致。</p>
                )}
                {f.result.dedup && (
                  <div className="import-stats">
                    <span>
                      新增 <b>{f.result.dedup.new_events}</b> 笔
                    </span>
                    <span>
                      更新 <b>{f.result.dedup.updated_events}</b> 笔
                    </span>
                    <span>
                      重复 <b>{f.result.dedup.unchanged_events}</b> 笔
                    </span>
                    {f.result.dedup.older_snapshots > 0 && (
                      <span>
                        跳过旧状态 <b>{f.result.dedup.older_snapshots}</b> 笔
                      </span>
                    )}
                    {f.result.dedup.trashed_events > 0 && (
                      <span>
                        跳过回收站 <b>{f.result.dedup.trashed_events}</b> 笔
                      </span>
                    )}
                  </div>
                )}
                {f.result.dedup?.trashed_events > 0 && (
                  <p className="notice small">
                    回收站中的交易未重新导入。需要更新这些交易时，请先恢复，再重新上传本文件。
                  </p>
                )}
                {f.result.errors?.map((e: any, k: number) => (
                  <p className="error-text" key={k}>
                    {e.location}：{e.message}
                  </p>
                ))}
              </>
            )}
          </div>
        ))
      ) : (
        <>
          {j.items?.map((i: any, n: number) => (
            <div className="job-file" key={n}>
              <div className="flex-between">
                <strong>
                  {i.action === "create" ? "新增" : "更新原单"} ·{" "}
                  {i.description}
                </strong>
                <Status value={i.state} />
              </div>
              <p>
                {money(i.amount)} · {i.message || "等待处理"}
              </p>
              {i.code && (
                <small>
                  飞书错误码 {i.code} · {i.log_id || ""}
                </small>
              )}
            </div>
          ))}
          {j.skipped?.map((s: any, i: number) => (
            <div className="job-file" key={i}>
              <p>跳过：{s.reason}</p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
