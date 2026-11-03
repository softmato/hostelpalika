package kitchen

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/email"
)

// ProvisionCook is provisionCookAccount: a credential cook named "<hostel> Cook"
// and the cook portal switched on. Approval issues it beside the owner's login.
func (a *Admin) ProvisionCook(ctx context.Context, hostel, actor bson.ObjectID) (*email.CookLogin, error) {
	facts, err := a.loadHostel(ctx, hostel)
	if err != nil {
		return nil, err
	}
	name := facts.Name + " Cook"
	_, creds, err := a.issueCredentialCook(ctx, actor, name, hostel, facts)
	if err != nil {
		return nil, err
	}
	if err := a.setPortalFlag(ctx, hostel, actor, true); err != nil {
		return nil, err
	}
	return &email.CookLogin{CookName: name, Email: creds.Email, TemporaryPassword: creds.TemporaryPassword}, nil
}
