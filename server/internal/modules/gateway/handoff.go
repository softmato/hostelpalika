package gateway

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// handoff is buildFormPostHandoff, behind the web's `/pay/[reference]` relay
// page (PARITY §9). eSewa's checkout is a signed form POST and a phone can only
// open URLs, so the app opens that page and the page posts the form. No
// session, by design: only a CREATED, unexpired intent is ever re-presented,
// and nothing in the answer but an amount and the merchant form.
func (h *Handler) handoff(c *gin.Context) {
	out, err := h.Service.Handoff(c, c.Param("reference"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "handoff", Value: out}}, "Payment hand-off ready")
}

// Handoff rebuilds the intent's form with the same arguments CreateIntent used,
// so the signature matches what the app was first handed. A REDIRECT provider
// needs no relay: the app opens Khalti's URL itself.
func (s *Service) Handoff(ctx context.Context, reference string) (ordered.Map, error) {
	var intent struct {
		Amount    int64         `bson:"amount"`
		Attempt   int           `bson:"attempt"`
		ExpiresAt time.Time     `bson:"expiresAt"`
		HostelID  bson.ObjectID `bson:"hostelId"`
		InvoiceID bson.ObjectID `bson:"invoiceId"`
		Mode      string        `bson:"mode"`
		Provider  string        `bson:"provider"`
		Reference string        `bson:"reference"`
		Status    string        `bson:"status"`
	}
	err := s.intents().FindOne(ctx, bson.D{{Key: "reference", Value: reference}}).Decode(&intent)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(http.StatusNotFound, "HANDOFF_NOT_FOUND", "This payment link is not valid.", nil)
	}
	if err != nil {
		return nil, err
	}
	// A SUCCEEDED intent re-presented would take the rent twice; a FAILED or
	// EXPIRED one goes back through the app so a fresh attempt is counted.
	if intent.Status != "CREATED" {
		return nil, httpx.NewError(http.StatusConflict, "HANDOFF_NOT_PAYABLE", "This payment has already been completed or cancelled.", nil)
	}
	if !intent.ExpiresAt.After(s.Now()) {
		return nil, httpx.NewError(http.StatusGone, "HANDOFF_EXPIRED", "This payment link has expired.", nil)
	}
	creds, err := s.Credentials(ctx, intent.HostelID, intent.Provider)
	if err != nil {
		return nil, err
	}
	adapter, err := s.provider(intent.Provider)
	if err != nil {
		return nil, err
	}
	rebuilt, err := adapter.CreateIntent(ctx, IntentRequest{Amount: intent.Amount, Attempt: intent.Attempt, Credentials: creds,
		CallbackURL: s.SiteURL + "/api/v1/webhooks/" + lower(intent.Provider),
		FailureURL:  s.SiteURL + "/resident/payments/checkout/" + intent.Reference + "?outcome=failed",
		Reference:   intent.Reference, ReferenceCode: intent.Reference,
		ReturnURL: s.SiteURL + "/resident/payments/checkout/" + intent.Reference})
	if err != nil {
		return nil, err
	}
	if kind, _ := rebuilt.Handoff.Get("kind"); kind != "FORM_POST" {
		return nil, httpx.NewError(http.StatusConflict, "HANDOFF_NOT_FORM_POST", "This provider does not need a relay page.", nil)
	}
	fields, _ := rebuilt.Handoff.Get("fields")
	url, _ := rebuilt.Handoff.Get("url")
	return ordered.Map{{Key: "amount", Value: intent.Amount}, {Key: "fields", Value: fields}, {Key: "provider", Value: intent.Provider},
		{Key: "reference", Value: intent.Reference}, {Key: "sandbox", Value: intent.Mode == "SANDBOX"}, {Key: "url", Value: url}}, nil
}
