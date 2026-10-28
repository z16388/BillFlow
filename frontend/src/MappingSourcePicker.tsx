import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
const meta: Record<string, [string, string]> = {
  sync_description: [
    "旧版兼容",
    "读取已有的旧版商户／商品显示规则。新简称请直接配置字段条件规则。未命中规则时回退商品，商品为空时使用商户。",
  ],
  merchant: ["账单信息", "原始商户名称，不应用显示替换。"],
  description: ["账单信息", "原始商品或交易描述，不应用显示替换。"],
  category: ["账单信息", "账单分类，包含手动修改；飞书消费类型可另设规则。"],
  transaction_type: ["账单信息", "平台交易类型，如转账、商户消费。"],
  note: ["账单信息", "账单备注，包含手动补充的内容。"],
  platform: [
    "支付与渠道",
    "账单文件来源，如京东、微信；不一定等于实际购物平台。",
  ],
  method: ["支付与渠道", "原始支付方式，如余额、银行卡；与文件来源不同。"],
  account: ["支付与渠道", "原始支付账户或卡号信息，可能为空。"],
  time: ["金额与日期", "交易发生时间，写入日期字段时自动转换。"],
  net: ["金额与日期", "原付减去已确认退款，单位元。"],
  amount: ["金额与日期", "原付金额，尚未扣除退款，单位元。"],
  refund: ["金额与日期", "已关联并确认的退款总额，单位元。"],
  order_id: ["交易标识", "平台交易单号，可能为空。"],
  id: ["交易标识", "工具生成的稳定同步标识，用于防止重复记账。"],
};
export function SourcePicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const info = (key: string): [string, string] =>
    meta[key] || [
      "已配置字段的加工结果",
      "工具计算出的字段结果，可供后续规则使用；不是飞书现有记录。",
    ];
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const matches = (key: string, name: string) =>
    (name + info(key).join(" ")).toLowerCase().includes(query.toLowerCase());
  return (
    <div
      className="mapping-source-picker"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="mapping-source-trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setQuery("");
        }}
      >
        <span>
          <strong>
            {options.find(([key]) => key === value)?.[1] || "选择数据来源"}
          </strong>
          {value && <small>{info(value)[0]}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {value && !open && (
        <p className="mapping-source-help">{info(value)[1]}</p>
      )}
      {open && (
        <div
          className="mapping-source-menu"
          role="region"
          aria-label={`${label}选项`}
        >
          <input
            autoFocus
            aria-label="搜索数据来源"
            placeholder="搜索名称或用途"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mapping-source-options">
            {[...new Set(options.map(([key]) => info(key)[0]))].map((group) => {
              const items = options.filter(
                ([key, name]) => info(key)[0] === group && matches(key, name),
              );
              return items.length ? (
                <section key={group}>
                  <h4>{group}</h4>
                  {items.map(([key, name]) => (
                    <button
                      type="button"
                      key={key}
                      aria-pressed={value === key}
                      onClick={() => {
                        onChange(key);
                        setOpen(false);
                        trigger.current?.focus();
                      }}
                    >
                      <span>
                        <strong>{name}</strong>
                        <small>{info(key)[1]}</small>
                      </span>
                      {value === key && <Check size={15} />}
                    </button>
                  ))}
                </section>
              ) : null;
            })}
            {!options.some(([key, name]) => matches(key, name)) && (
              <p>没有匹配的来源</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
