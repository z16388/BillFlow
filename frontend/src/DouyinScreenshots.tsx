import { useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Loader2 } from "lucide-react";
import { api, money } from "./lib";
import { Button, Modal } from "./components/ui";
import DouyinOrderPicker, { type ScreenshotOrder } from "./DouyinOrderPicker";

type Order = ScreenshotOrder;
type Card = {
  id: string;
  merchant: string;
  description: string;
  paid_amount: number | null;
  amount_inferred: boolean;
  status: string;
  top: number;
  bottom: number;
};
type ImageResult = {
  id: string;
  filename: string;
  width: number;
  height: number;
  cards: Card[];
};
function OrderCrop({
  image,
  card,
  url,
}: {
  image: ImageResult;
  card: Card;
  url: string;
}) {
  return (
    <svg
      className="screenshot-crop-image"
      viewBox={`0 ${card.top} ${image.width} ${card.bottom - card.top}`}
      role="img"
      aria-label="订单截图内容"
    >
      <image href={url} width={image.width} height={image.height} />
    </svg>
  );
}
type Edit = {
  merchant: string;
  description: string;
  amount: string;
  event_id: string;
  checked: boolean;
  mismatch: boolean;
};
const key = (image: string, card: string) => image + ":" + card;
function cents(value: string): number | null {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return null;
  const [a, b = ""] = value.split(".");
  const n = Number(a) * 100 + Number((b + "00").slice(0, 2));
  return Number.isSafeInteger(n) ? n : null;
}
export default function DouyinScreenshots({
  files,
  close,
  done,
  notify,
}: {
  files: File[] | null;
  close: () => void;
  done: () => Promise<void>;
  notify: (s: string, e?: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    preview_id: string;
    images: ImageResult[];
    orders: Order[];
  } | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [page, setPage] = useState(0);
  const [saving, setSaving] = useState(false);
  const [large, setLarge] = useState<{ im: ImageResult; card: Card } | null>(
    null,
  );
  const [picker, setPicker] = useState<{
    key: string;
    recommendedIds: string[];
  } | null>(null);
  const urls = useMemo(
    () => files?.map((f) => URL.createObjectURL(f)) || [],
    [files],
  );
  useEffect(() => () => urls.forEach(URL.revokeObjectURL), [urls]);
  async function recognize(selected: File[]) {
    if (!selected.length) return;
    setLoading(true);
    setError("");
    setResult(null);
    setEdits({});
    setPage(0);
    setPicker(null);
    setLarge(null);
    const fd = new FormData();
    selected.forEach((f) => fd.append("files", f));
    try {
      const res = await api("/douyin-screenshots/preview", {
        method: "POST",
        body: fd,
      });
      setResult(res);
      const next: Record<string, Edit> = {};
      res.images.forEach((im: ImageResult) =>
        im.cards.forEach((c: Card) => {
          const matches = res.orders.filter(
            (o: Order) => o.amount === c.paid_amount,
          );
          next[key(im.id, c.id)] = {
            merchant: c.merchant,
            description: c.description,
            amount:
              c.paid_amount === null ? "" : (c.paid_amount / 100).toFixed(2),
            event_id: matches.length === 1 ? matches[0].id : "",
            checked: false,
            mismatch: false,
          };
        }),
      );
      setEdits(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (files?.length) void recognize(files);
  }, [files]);
  const drop = useDropzone({
    accept: {
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
    },
    maxSize: 20 * 1024 * 1024,
    onDrop: (accepted) => {
      if (accepted.length) {
        notify("请关闭窗口后重新选择截图", true);
      }
    },
  });
  const items =
    result?.images.flatMap((im) => im.cards.map((card) => ({ im, card }))) ||
    [];
  const perPage = 3;
  const selected = Object.values(edits).filter((e) => e.checked).length;
  const maxPage = Math.max(0, Math.ceil(items.length / perPage) - 1);
  function change(k: string, patch: Partial<Edit>) {
    setEdits((old) => ({ ...old, [k]: { ...old[k], ...patch } }));
  }
  async function apply() {
    if (!result) return;
    const selections = items.flatMap(({ im, card }) => {
      const e = edits[key(im.id, card.id)];
      return e?.checked
        ? [
            {
              image_id: im.id,
              card_id: card.id,
              event_id: e.event_id,
              merchant: e.merchant,
              description: e.description,
              paid_amount: cents(e.amount),
              allow_amount_mismatch: e.mismatch,
            },
          ]
        : [];
    });
    if (
      selections.some(
        (s) => !s.event_id || (!s.merchant.trim() && !s.description.trim()),
      )
    ) {
      setError("请为已勾选的订单选择账单并填写商户或商品");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const r = await api(`/douyin-screenshots/${result.preview_id}/apply`, {
        method: "POST",
        body: JSON.stringify({ selections }),
      });
      await done();
      notify(`已为 ${r.updated} 笔账单补充信息`);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={files !== null}
      onClose={close}
      title="补充抖音订单信息"
      description="根据截图实付款查找候选账单；请逐笔核对，勾选后才会保存。"
      wide
    >
      {loading && (
        <div className="screenshot-loading">
          <Loader2 className="spin" size={24} /> 正在本机离线识别截图，请稍候…
        </div>
      )}
      {error && (
        <div className="screenshot-error" role="alert">
          {error}
        </div>
      )}
      {!loading && result && (
        <>
          <div className="screenshot-note">
            截图可能截断商品名或识别错字，请对照图片修改。截图无订单号，金额相同也不能保证是同一笔；退款和会员费可能造成金额不同。
          </div>
          {!items.length ? (
            <div className="screenshot-empty">
              没有识别到订单卡片。请使用抖音「全部订单」列表截图，尽量保留完整商户行和实付款。
            </div>
          ) : (
            <div className="screenshot-list">
              {items
                .slice(page * perPage, (page + 1) * perPage)
                .map(({ im, card }) => {
                  const k = key(im.id, card.id),
                    e = edits[k];
                  if (!e) return null;
                  const amount = cents(e.amount);
                  const exact = result.orders.filter(
                    (o) => amount !== null && o.amount === amount,
                  );
                  const chosen = result.orders.find((o) => o.id === e.event_id);
                  const mismatch =
                    !!chosen && (amount === null || chosen.amount !== amount);
                  const index = im.cards.findIndex((c) => c.id === card.id);
                  const anchors = im.cards
                    .map((c, i) => {
                      const edited = edits[key(im.id, c.id)];
                      const amt = edited ? cents(edited.amount) : null;
                      const matches = result.orders
                        .map((o, j) => ({ o, j }))
                        .filter((x) => amt !== null && x.o.amount === amt);
                      return matches.length === 1
                        ? { i, j: matches[0].j }
                        : null;
                    })
                    .filter((a): a is { i: number; j: number } => a !== null);
                  const before = anchors.filter((a) => a.i < index).at(-1),
                    after = anchors.find((a) => a.i > index);
                  const ordered = exact.filter((o) => {
                    const j = result.orders.findIndex((v) => v.id === o.id);
                    return (!before || j > before.j) && (!after || j < after.j);
                  });
                  const consistent = !(before && after && before.j >= after.j);
                  const suggestion =
                    consistent &&
                    (before || after) &&
                    ordered.length &&
                    ordered.length < exact.length
                      ? ` · 按上下订单顺序推测 ${ordered.length} 笔（仍需核对）`
                      : "";
                  return (
                    <article className="screenshot-card" key={k}>
                      <div className="screenshot-image">
                        <button
                          type="button"
                          aria-label="放大订单截图"
                          title="点击放大"
                          onClick={() => setLarge({ im, card })}
                          className="screenshot-crop"
                        >
                          <OrderCrop
                            image={im}
                            card={card}
                            url={urls[Number(im.id)]}
                          />
                        </button>
                        <small>
                          点击截图可放大
                          <br />
                          {im.filename} · 第 {Number(card.id) + 1} 笔
                        </small>
                      </div>
                      <div className="screenshot-fields">
                        <div className="screenshot-card-heading">
                          <strong>订单 {Number(card.id) + 1}</strong>
                          <span>{card.status}</span>
                          <label>
                            <input
                              type="checkbox"
                              checked={e.checked}
                              onChange={(v) =>
                                change(k, { checked: v.target.checked })
                              }
                            />{" "}
                            确认补充
                          </label>
                        </div>
                        <div className="screenshot-grid">
                          <label>
                            商户
                            <input
                              value={e.merchant}
                              onChange={(v) =>
                                change(k, { merchant: v.target.value })
                              }
                            />
                          </label>
                          <label>
                            商品 / 描述
                            <input
                              value={e.description}
                              onChange={(v) =>
                                change(k, { description: v.target.value })
                              }
                            />
                          </label>
                          <label>
                            截图实付款（元）
                            <input
                              inputMode="decimal"
                              value={e.amount}
                              onChange={(v) =>
                                change(k, {
                                  amount: v.target.value,
                                  event_id: "",
                                  checked: false,
                                  mismatch: false,
                                })
                              }
                            />
                          </label>
                        </div>
                        <div className="screenshot-association">
                          <div className="screenshot-association-heading">
                            <strong>关联账单</strong>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setPicker({
                                  key: k,
                                  recommendedIds: suggestion
                                    ? ordered.map((o) => o.id)
                                    : [],
                                })
                              }
                            >
                              {chosen ? "更换账单" : "选择账单"}
                            </Button>
                          </div>
                          <span className="screenshot-association-hint">
                            {exact.length === 1
                              ? "金额有 1 个候选"
                              : exact.length
                                ? `金额相同 ${exact.length} 笔`
                                : "未找到同金额账单，可筛选全部抖音账单"}
                            {suggestion}
                          </span>
                          {chosen ? (
                            <div className="screenshot-association-summary">
                              <strong>
                                {chosen.time.slice(0, 16)} ·{" "}
                                {money(chosen.amount)}
                              </strong>
                              <span>
                                {chosen.merchant || "无商户"} /{" "}
                                {chosen.description || "无商品描述"}
                              </span>
                              <small>
                                订单号：{chosen.order_id || "无"}
                                {chosen.existing ? " · 已补充，确认后替换" : ""}
                              </small>
                            </div>
                          ) : (
                            <p className="screenshot-order-info">
                              按日期、金额、账单状态和补充状态筛选后选择。
                            </p>
                          )}
                        </div>
                        {mismatch && (
                          <label className="screenshot-mismatch">
                            <input
                              type="checkbox"
                              checked={e.mismatch}
                              onChange={(v) =>
                                change(k, { mismatch: v.target.checked })
                              }
                            />{" "}
                            金额不一致，我已核对确认是同一笔
                          </label>
                        )}
                      </div>
                    </article>
                  );
                })}
            </div>
          )}
          <div className="screenshot-footer">
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>{" "}
              <span>
                {page + 1} / {maxPage + 1}
              </span>{" "}
              <Button
                variant="outline"
                size="sm"
                disabled={page >= maxPage}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>{" "}
              <span>共 {items.length} 笔</span>
            </div>
            <Button disabled={!selected || saving} onClick={apply}>
              {saving ? "保存中…" : `确认补充 ${selected} 笔`}
            </Button>
          </div>
        </>
      )}
      {!loading && !result && !error && (
        <div {...drop.getRootProps()}>
          <input {...drop.getInputProps()} />
          请选择截图
        </div>
      )}
      {picker && result && edits[picker.key] && (
        <DouyinOrderPicker
          key={picker.key}
          orders={result.orders}
          paidAmount={cents(edits[picker.key].amount)}
          selectedId={edits[picker.key].event_id}
          recommendedIds={picker.recommendedIds}
          reservedIds={Object.entries(edits)
            .filter(([k, e]) => k !== picker.key && e.checked && e.event_id)
            .map(([, e]) => e.event_id)}
          description={[
            edits[picker.key].merchant,
            edits[picker.key].description,
          ]
            .filter(Boolean)
            .join(" / ")}
          close={() => setPicker(null)}
          onSelect={(id) => {
            change(picker.key, {
              event_id: id,
              checked: false,
              mismatch: false,
            });
            setPicker(null);
          }}
        />
      )}
      <Modal
        open={large !== null}
        onClose={() => setLarge(null)}
        title="订单截图"
        description="对照截图核对商户、商品和实付款。"
      >
        <div className="screenshot-large">
          {large && (
            <OrderCrop
              image={large.im}
              card={large.card}
              url={urls[Number(large.im.id)]}
            />
          )}
        </div>
      </Modal>
    </Modal>
  );
}
