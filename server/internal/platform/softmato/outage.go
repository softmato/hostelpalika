package softmato

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// DownMessage is SOFTMATO_DOWN_MESSAGE: what a payer reads while Softmato is down.
const DownMessage = "Our parent company's server is not responding right now. We have saved this and will email you to complete it as soon as the server is back. Thank you for your patience."

// Unless is unlessSoftmatoDown's catch: a refusal is said as one (502), an
// outage is remembered for the retry job and said plainly (503), anything else
// passes through. remember may be nil when there is nothing to retry.
func Unless(ctx context.Context, err error, remember func(context.Context) error) error {
	if err == nil {
		return nil
	}
	var api *APIError
	if errors.As(err, &api) && !IsDown(err) {
		slog.ErrorContext(ctx, "softmato_request_rejected", "category", "payments", "code", api.Code, "status", api.Status, "error", api.Message)
		msg := api.Message
		if msg == "" {
			msg = "the request was refused."
		}
		return httpx.NewError(http.StatusBadGateway, "SOFTMATO_REJECTED", "Our payment server could not accept this: "+msg, nil)
	}
	if !IsDown(err) {
		return err
	}
	if remember != nil {
		if rerr := remember(ctx); rerr != nil {
			return rerr
		}
	}
	return httpx.NewError(http.StatusServiceUnavailable, "SOFTMATO_UNAVAILABLE", DownMessage, nil)
}
