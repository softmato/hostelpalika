package ledger

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// VoidedInvoice is voidInvoice's answer.
type VoidedInvoice struct {
	InvoiceID string `json:"invoiceId"`
	Status    string `json:"status"`
}

// VoidInvoice is voidInvoice: the invoice keeps its amount and history and stops being
// an obligation. An invoice with settled money cannot be voided: reverse it first, so
// the resident is told and the reversal stays on the ledger.
func (e *Engine) VoidInvoice(ctx context.Context, rawID string, p *authz.Principal, reason string) (*VoidedInvoice, error) {
	missing := finance.Err("INVOICE_NOT_FOUND", "Invoice was not found.")
	if len(strings.TrimSpace(reason)) < 3 {
		return nil, finance.Err("AMOUNT_OUT_OF_BOUNDS", "Voiding an invoice needs a reason.")
	}
	id, err := bson.ObjectIDFromHex(rawID)
	if err != nil {
		return nil, missing
	}
	scope := bson.A{}
	for _, h := range p.HostelIDs {
		if oid, err := bson.ObjectIDFromHex(h); err == nil {
			scope = append(scope, oid)
		}
	}
	var inv struct {
		ID         bson.ObjectID `bson:"_id"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		ResidentID bson.ObjectID `bson:"residentId"`
		Status     string        `bson:"status"`
		Total      int64         `bson:"totalAmount"`
	}
	err = e.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scope}}}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, missing
	}
	if err != nil {
		return nil, err
	}
	if inv.Status == "VOID" {
		return &VoidedInvoice{inv.ID.Hex(), "VOID"}, nil
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	err = appmongo.InTx(ctx, e.DB, func(ctx context.Context) error {
		settled, err := e.DB.Collection("paymentevents").CountDocuments(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}, {Key: "status", Value: "SETTLED"}})
		if err != nil {
			return err
		}
		if settled > 0 {
			return finance.Err("INVOICE_HAS_SETTLED_PAYMENTS", "This invoice has settled payments. Reverse them before voiding it.")
		}
		at := now()
		if _, err := e.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VOID"}, {Key: "updatedBy", Value: me},
			{Key: "voidReason", Value: reason}, {Key: "voidedAt", Value: at}, {Key: "voidedBy", Value: me}, {Key: "updatedAt", Value: at}}}}); err != nil {
			return err
		}
		_, err = e.DB.Collection("khataentries").UpdateMany(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "invoiceId", Value: nil}, {Key: "updatedAt", Value: at}}}})
		return err
	})
	if err != nil {
		return nil, err
	}
	if e.Audit != nil {
		if err := e.Audit.WriteFinance(ctx, me, string(p.Role), audit.Finance{Action: "INVOICE_VOIDED", AmountBefore: inv.Total, EntityID: inv.ID.Hex(), EntityType: "Invoice", HostelID: inv.HostelID, InvoiceID: inv.ID.Hex(), Reason: reason, Source: "INVOICE_VOID"}); err != nil {
			slog.ErrorContext(ctx, "finance audit failed after voiding an invoice", "invoiceId", inv.ID.Hex(), "error", err)
		}
	}
	e.NotifyResident(ctx, inv.HostelID, inv.ResidentID, "Bill cancelled", "Your bill of NPR "+money.GroupUS(inv.Total)+" was cancelled. "+strings.TrimSpace(reason),
		ordered.Map{{Key: "invoiceId", Value: inv.ID.Hex()}, {Key: "type", Value: "INVOICE_VOIDED"}})
	return &VoidedInvoice{inv.ID.Hex(), "VOID"}, nil
}
