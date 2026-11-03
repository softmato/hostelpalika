package softmato

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// GetTransactionStatus is getTransaction's status, upper-cased; "" when Softmato
// has no such transaction.
func (c *Client) GetTransactionStatus(ctx context.Context, transactionID string) (string, error) {
	var out struct {
		Status string `json:"status"`
	}
	if err := c.do(ctx, http.MethodGet, "/transactions/"+url.PathEscape(transactionID), nil, &out); err != nil {
		if IsNotFound(err) {
			return "", nil
		}
		return "", err
	}
	return strings.ToUpper(out.Status), nil
}
