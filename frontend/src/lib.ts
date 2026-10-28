import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const money = (fen: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    fen / 100,
  );
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      "X-Requested-With": "zhangdan",
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("session-expired"));
    const err = await response.json().catch(() => ({}));
    const message =
      typeof err.detail === "string"
        ? err.detail
        : "请求失败，请检查输入或服务器连接";
    throw new Error(
      message +
        (err.code ? `（飞书 ${err.code}）` : "") +
        (err.log_id ? ` · 日志 ${err.log_id}` : ""),
    );
  }
  return response.json();
}
export type Event = {
  mapped_description?: string;
  id: string;
  platform: string;
  account: string;
  time: string;
  amount: number;
  merchant: string;
  description: string;
  order_id: string;
  merchant_id: string;
  state: string;
  category: string;
  method: string;
  kind: string;
  direction: string;
  location: string;
  file_name: string;
  reason: string;
  transaction_type?: string;
};
export type Expense = Event & {
  automatic_exclusion?: string;
  douyin_duplicate_exempt?: boolean;
  douyin_duplicate?: { certain: boolean; original_id: string | null; original_order: string; original_time: string; basis: string };
  douyin_order_info?: {event_id:string; image_name:string; position:number};
  net: number;
  refund: number;
  status: string;
  reasons: string[];
  members: Event[];
  refunds: Event[];
  platforms: string[];
  note: string;
  suspects: { id: string; merchant: string; platform: string; time: string }[];
  existing_candidates: any[];
  record_id: string | null;
  remote_amount?: number;
  sync_description?: string;
  display_rule?: string | null;
  filter_rules?: string[];
  update_reason?: string;
  filter_exempt?: boolean;
};
export type Refund = Event & {
  statement_amount?: number;
  refund_adjusted?: boolean;
  refund_adjustment_reason?: string;
  refund_original_order?: string;
  status: string;
  basis: string;
  target?: string;
  candidates: Pick<
    Event,
    "id" | "time" | "merchant" | "amount" | "description"
  >[];
};
export type LedgerData = {
  expenses: Expense[];
  refunds: Refund[];
  excluded: Event[];
  summary: Record<string, number>;
  files: any[];
  remote_checked: boolean;
};
export const statuses: Record<string, string> = {
  new: "待新增",
  update: "待更新",
  review: "待确认",
  recorded: "已记录",
  refunded: "已全额退款",
  filtered: "已过滤",
  excluded: "已排除",
  matched: "已关联",
  unmatched: "待匹配",
  ignored: "已排除",
  queued: "排队中",
  running: "处理中",
  done: "已完成",
  partial: "需处理",
  success: "成功",
  failed: "失败",
  unknown: "结果待核对",
  sending: "写入中",
  duplicate: "重复文件",
  error: "解析失败",
  parsing: "解析中",
};
