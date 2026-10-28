import { Search, CheckCheck, X } from "lucide-react";
import { Button } from "./ui";
import { dateRange } from "../dates";
import { DateInput } from "./DateInput";
export const SOURCES = ["微信", "支付宝", "京东", "美团", "抖音", "手动"];
export default function SharedFilters({
  sources,
  onSources,
  from,
  to,
  onFrom,
  onTo,
  search,
  onSearch,
}: {
  sources: string[];
  onSources: (value: string[]) => void;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  search: string;
  onSearch: (value: string) => void;
}) {
  return (
    <section className="shared-filters" aria-label="账单通用筛选">
      <div className="source-filters" role="group" aria-label="账单来源">
        <span className="filter-label">来源</span>
        {SOURCES.map((source) => (
          <label
            key={source}
            className={
              "source-filter-option " +
              (sources.includes(source) ? "is-selected" : "")
            }
          >
            <input
              type="checkbox"
              checked={sources.includes(source)}
              onChange={(e) =>
                onSources(
                  e.target.checked
                    ? [...sources, source]
                    : sources.filter((s) => s !== source),
                )
              }
            />
            {source}
          </label>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={sources.length === SOURCES.length}
          onClick={() => onSources([...SOURCES])}
        >
          <CheckCheck size={14} />
          全选来源
        </Button>
        {!sources.length && (
          <span className="source-empty">请至少选择一个来源</span>
        )}
      </div>
      <div className="date-presets" role="group" aria-label="日期快捷筛选">
        {[
          ["month", "本月"],
          ["seven", "近七天"],
          ["one", "近一个月"],
          ["three", "近三个月"],
          ["all", "全部日期"],
        ].map(([key, label]) => {
          const range = dateRange(key);
          return (
            <Button
              key={key}
              variant="outline"
              size="sm"
              aria-pressed={from === range[0] && to === range[1]}
              onClick={() => {
                onFrom(range[0]);
                onTo(range[1]);
              }}
            >
              {label}
            </Button>
          );
        })}
      </div>
      <div className="shared-filter-bottom">
        <div className="shared-date-range">
          <span className="filter-label">日期</span>
          <DateInput
            type="date"
            aria-label="起始日期"
            value={from}
            max={to || undefined}
            onInput={(e) => onFrom(e.currentTarget.value)}
            onChange={(e) => onFrom(e.target.value)}
          />
          <span className="date-to">至</span>
          <DateInput
            type="date"
            aria-label="结束日期"
            value={to}
            min={from || undefined}
            onInput={(e) => onTo(e.currentTarget.value)}
            onChange={(e) => onTo(e.target.value)}
          />
          {(from || to) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onFrom("");
                onTo("");
              }}
            >
              <X size={13} />
              清除日期
            </Button>
          )}
        </div>
        <div className="search shared-search">
          <Search size={15} />
          <input
            placeholder="搜索商户、商品或单号"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="搜索账单"
          />
        </div>
      </div>
    </section>
  );
}
