package financeadmin

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
)

// SeedOpeningRateCard is seedOpeningRateCard's createFeeSchedule call: a team
// registration's rents become the hostel's first rate card, from this month, as
// the field agent who filed it.
func (h *Handler) SeedOpeningRateCard(ctx context.Context, hostel bson.ObjectID, admission, form, deposit, referral int64, rates []hostels.OpeningRate, actor string) error {
	in := scheduleInput{Admission: &admission, Form: &form, Deposit: &deposit, Referral: &referral, From: time.Now()}
	for _, r := range rates {
		rt := r.RoomType
		doc := rateDoc{RoomType: &rt, Monthly: r.Monthly}
		if b := finance.NormalizeBedType(rt); b != "" {
			doc.BedType = &b
		}
		in.Rates = append(in.Rates, doc)
	}
	_, err := h.createSchedule(ctx, hostel, in, &authz.Principal{UserID: actor, Role: "PLATFORM_AGENT", HostelIDs: []string{hostel.Hex()}})
	return err
}
