import { escapeHtml } from "../layout";

export type StoreEmailItem = {
  imageUrl?: string;
  lineTotal: number;
  name: string;
  quantity: number;
  stockAfterOrder?: number | null;
  unit: string;
  unitPrice: number;
};

export function formatNpr(paisa: number) {
  return `NPR ${(paisa / 100).toLocaleString("en-NP", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

export function itemsTable(
  items: readonly StoreEmailItem[],
  includeStock = false,
) {
  const rows = items
    .map((item) => {
      const stock =
        // `!= null`: an untracked product's null used to print "null left after order".
        includeStock && item.stockAfterOrder != null

          ? `<br/><span style="color:${item.stockAfterOrder === 0 ? "#b91c1c" : "#64748b"};font-size:12px;">${item.stockAfterOrder === 0 ? "Just hit zero" : `${item.stockAfterOrder} left after order`}</span>`
          : "";
      const image = item.imageUrl
        ? `<img src="${escapeHtml(item.imageUrl)}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;object-fit:cover;border-radius:6px;"/>`
        : `<span style="display:block;width:48px;height:48px;background:#e2e8f0;border-radius:6px;"></span>`;

      return `<tr>
  <td style="padding:10px 0;vertical-align:top;width:60px;">${image}</td>
  <td style="padding:10px 8px;vertical-align:top;font-size:14px;line-height:1.45;">${escapeHtml(item.name)}${stock}<br/><span style="color:#64748b;font-size:12px;">${item.quantity} × ${escapeHtml(item.unit)} · ${formatNpr(item.unitPrice)}</span></td>
  <td style="padding:10px 0;vertical-align:top;text-align:right;font-size:14px;white-space:nowrap;">${formatNpr(item.lineTotal)}</td>
</tr>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:20px 0;">${rows}</table>`;
}
