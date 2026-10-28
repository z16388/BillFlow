import { type Expense, type Refund, money } from "./lib";
export default function SyncOriginalDetail({ expense }: { expense: Expense }) {
  return (
    <div className="sync-original-detail">
      <div className="sync-original-heading">
        <h3>{expense.merchant || expense.description}</h3>
        <p>原始商品：{expense.description || "未提供商品描述"}</p>
      </div>
      <dl className="sync-original-totals">
        <div>
          <dt>账单原付</dt>
          <dd>{money(expense.amount)}</dd>
        </div>
        <div>
          <dt>已关联退款</dt>
          <dd>{money(expense.refund)}</dd>
        </div>
        <div>
          <dt>账单净支出</dt>
          <dd>{money(expense.net)}</dd>
        </div>
      </dl>
      <h4>
        原始记录
        {expense.members.length > 1
          ? `（${expense.members.length} 个来源）`
          : ""}
      </h4>
      {(expense.members.length ? expense.members : [expense]).map((record) => (
        <section className="sync-original-record" key={record.id}>
          <div className="sync-original-record-heading">
            <strong>{record.platform}</strong>
            <span>{money(record.amount)}</span>
          </div>
          <dl>
            {[
              ["交易时间", record.time],
              ["商户", record.merchant],
              ["商品／描述", record.description],
              ["交易订单号", record.order_id],
              ["商家单号", record.merchant_id],
              ["支付方式", record.method],
              ["支付账户", record.account],
              ["交易类型", record.transaction_type],
              ["原始状态", record.state],
              ["来源文件", record.file_name],
              ["文件位置", record.location],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {!!expense.refunds.length && (
        <>
          <h4>已关联退款</h4>
          {expense.refunds.map((event) => {
            const refund = event as Refund;
            return (
              <section className="sync-original-record" key={event.id}>
                <div className="sync-original-record-heading">
                  <strong>
                    {event.platform} · {event.time}
                  </strong>
                  <span>{money(event.amount)}</span>
                </div>
                <dl>
                  <div>
                    <dt>退款单号</dt>
                    <dd>{event.order_id}</dd>
                  </div>
                  {refund.refund_adjusted && (
                    <>
                      <div>
                        <dt>流水原金额</dt>
                        <dd>
                          {money(refund.statement_amount ?? event.amount)}
                        </dd>
                      </div>
                      <div>
                        <dt>修正依据</dt>
                        <dd>{refund.refund_adjustment_reason}</dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>来源位置</dt>
                    <dd>
                      {event.file_name} · {event.location}
                    </dd>
                  </div>
                </dl>
              </section>
            );
          })}
        </>
      )}
      {expense.note && (
        <p className="sync-original-note">账单备注：{expense.note}</p>
      )}
    </div>
  );
}
