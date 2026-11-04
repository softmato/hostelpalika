package email

import (
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// StoreItem is StoreEmailItem (templates/store/items-table.ts). StockAfterOrder
// nil is a product that does not track stock.
type StoreItem struct {
	ImageURL        string
	LineTotal       int64
	Name            string
	Quantity        int64
	StockAfterOrder *int64
	Unit            string
	UnitPrice       int64
}

func storeItemsTable(items []StoreItem, includeStock bool) string {
	var rows strings.Builder
	for _, it := range items {
		stock := ""
		// TS tested `!== undefined`, so an untracked product (null) printed
		// "null left after order"; fixed on both sides (review_fixes_needed P7-6).
		if includeStock && it.StockAfterOrder != nil {
			color, text := "#64748b", strconv.FormatInt(*it.StockAfterOrder, 10)+" left after order"
			if *it.StockAfterOrder == 0 {
				color, text = "#b91c1c", "Just hit zero"
			}
			stock = `<br/><span style="color:` + color + `;font-size:12px;">` + text + `</span>`
		}
		image := `<span style="display:block;width:48px;height:48px;background:#e2e8f0;border-radius:6px;"></span>`
		if it.ImageURL != "" {
			image = `<img src="` + EscapeHTML(it.ImageURL) + `" alt="" width="48" height="48" style="display:block;width:48px;height:48px;object-fit:cover;border-radius:6px;"/>`
		}
		rows.WriteString(`<tr>
  <td style="padding:10px 0;vertical-align:top;width:60px;">` + image + `</td>
  <td style="padding:10px 8px;vertical-align:top;font-size:14px;line-height:1.45;">` + EscapeHTML(it.Name) + stock + `<br/><span style="color:#64748b;font-size:12px;">` +
			strconv.FormatInt(it.Quantity, 10) + ` × ` + EscapeHTML(it.Unit) + ` · ` + money.FormatStoreNPR(it.UnitPrice) + `</span></td>
  <td style="padding:10px 0;vertical-align:top;text-align:right;font-size:14px;white-space:nowrap;">` + money.FormatStoreNPR(it.LineTotal) + `</td>
</tr>`)
	}
	return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:20px 0;">` + rows.String() + `</table>`
}

// StoreOrderFacts are the fields the placed/received emails share.
type StoreOrderFacts struct {
	Address, ContactName, DeliveryPromise, HostelName, Note, OrderNumber, Phone string
	DeliveryFee, Subtotal, Total                                                int64
	Items                                                                       []StoreItem
}

func storeTotals(f StoreOrderFacts) string {
	fee := "Free"
	if f.DeliveryFee != 0 {
		fee = money.FormatStoreNPR(f.DeliveryFee)
	}
	return Paragraph("Subtotal: <strong>" + money.FormatStoreNPR(f.Subtotal) + "</strong><br/>Delivery: <strong>" + fee + "</strong><br/>Total: <strong>" + money.FormatStoreNPR(f.Total) + "</strong>")
}

func courierNote(note string) string {
	if note == "" {
		return ""
	}
	return "<br/>Courier note: " + EscapeHTML(note)
}

// StoreOrderPlacedBuyer is storeOrderPlacedBuyerEmail.
func StoreOrderPlacedBuyer(f StoreOrderFacts, createdAt, orderURL string) Content {
	return Content{Category: Info, Subject: "Order " + f.OrderNumber + " placed — " + money.FormatStoreNPR(f.Total), HTML: EmailLayout(Layout{
		Heading: "We've got your order",
		BodyHTML: strings.Join([]string{
			Paragraph(EscapeHTML(f.HostelName) + " · order <strong>" + EscapeHTML(f.OrderNumber) + "</strong> · placed " + EscapeHTML(createdAt) + "."),
			Paragraph("Placed at " + EscapeHTML(createdAt) + " — arriving <strong>" + EscapeHTML(f.DeliveryPromise) + "</strong>."),
			storeItemsTable(f.Items, false),
			storeTotals(f),
			Paragraph("Pay cash when it arrives. Please keep <strong>" + money.FormatStoreNPR(f.Total) + "</strong> ready."),
			Paragraph("Delivery address: " + EscapeHTML(f.Address) + "<br/>Contact: " + EscapeHTML(f.ContactName) + " · " + EscapeHTML(f.Phone) + courierNote(f.Note)),
			Paragraph("You can cancel in the app until it is sent."),
			CTAButton(orderURL, "Track this order"),
		}, "\n"),
	})}
}

// StoreOrderReceivedPlatform is storeOrderReceivedPlatformEmail.
func StoreOrderReceivedPlatform(f StoreOrderFacts, placedByName, ordersURL string) Content {
	return Content{Category: Alert, Subject: "New order · " + f.HostelName + " · " + money.FormatStoreNPR(f.Total) + " · " + f.OrderNumber, HTML: EmailLayout(Layout{
		Heading: "New order to deliver",
		Urgent:  true,
		BodyHTML: strings.Join([]string{
			Paragraph("<strong>" + EscapeHTML(f.HostelName) + "</strong> placed order <strong>" + EscapeHTML(f.OrderNumber) + "</strong>."),
			Paragraph("Placed by " + EscapeHTML(placedByName) + " · " + EscapeHTML(f.Phone) + ".<br/><strong>Deliver by " + EscapeHTML(f.DeliveryPromise) + ".</strong>"),
			storeItemsTable(f.Items, true),
			storeTotals(f),
			Paragraph("Collect <strong>" + money.FormatStoreNPR(f.Total) + "</strong> in cash on delivery."),
			Paragraph("Delivery address: " + EscapeHTML(f.Address) + "<br/>Contact: " + EscapeHTML(f.ContactName) + ` · <a href="tel:` + EscapeHTML(f.Phone) + `">` + EscapeHTML(f.Phone) + "</a>" + courierNote(f.Note)),
			CTAButton(ordersURL, "Open orders"),
		}, "\n"),
	})}
}

// StoreOrderStatusBuyer is storeOrderStatusBuyerEmail; status is CONFIRMED,
// SHIPPED, DELIVERED or CANCELLED.
func StoreOrderStatusBuyer(status, orderNumber, orderURL, deliveryPromise, note, cancelledReason string, total int64, items []StoreItem) Content {
	t := money.FormatStoreNPR(total)
	var copy string
	switch status {
	case "CANCELLED":
		copy = "Your order was cancelled. Nothing is owed."
	case "CONFIRMED":
		copy = "We're preparing your order. It is due " + deliveryPromise + "; please keep " + t + " ready."
	case "DELIVERED":
		copy = "Delivered. You paid " + t + ". Reply to us if anything is wrong."
	case "SHIPPED":
		n := ""
		if note != "" {
			n = " · courier note: " + note
		}
		copy = "Your order is on the way. It is due " + deliveryPromise + "; please keep " + t + " ready" + n + "."
	}
	lower := strings.ToLower(status)
	heading := "Order " + lower
	reason, cta := "", CTAButton(orderURL, "Track this order")
	if status == "CANCELLED" {
		heading, cta = "Order cancelled", ""
		if cancelledReason != "" {
			reason = Paragraph("Reason: " + EscapeHTML(cancelledReason))
		}
	}
	return Content{Category: Info, Subject: "Order " + orderNumber + " — " + lower, HTML: EmailLayout(Layout{
		Heading: heading,
		BodyHTML: strings.Join([]string{
			Paragraph("<strong>" + EscapeHTML(orderNumber) + "</strong>"),
			Paragraph(EscapeHTML(copy)),
			storeItemsTable(items, false),
			reason,
			cta,
		}, "\n"),
	})}
}
