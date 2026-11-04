package safety

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

const (
	nightStatusCategory   = "night-status"
	nightStatusAnswerPath = "/api/v1/resident/night-status/answer"
	defaultPromptTime     = "20:00"
)

type nightSetting struct {
	HostelID   bson.ObjectID `bson:"hostelId"`
	Attendance struct {
		NightStatus *struct {
			PromptEnabled      *bool  `bson:"promptEnabled"`
			PromptTime         string `bson:"promptTime"`
			RepeatEveryMinutes int    `bson:"repeatEveryMinutes"`
		} `bson:"nightStatus"`
	} `bson:"attendance"`
}

type promptCall struct {
	hostelID   bson.ObjectID
	kind       string
	round      int
	promptTime string
}

// duePrompts: hostels whose night asking window is open at now, with the round.
// Prompting is on unless a hostel switched it off.
func duePrompts(rows []nightSetting, now time.Time) []promptCall {
	var out []promptCall
	for _, r := range rows {
		cfg := r.Attendance.NightStatus
		if cfg != nil && cfg.PromptEnabled != nil && !*cfg.PromptEnabled {
			continue
		}
		at, every := defaultPromptTime, 0
		if cfg != nil {
			if t := strings.TrimSpace(cfg.PromptTime); t != "" {
				at = t
			}
			every = cfg.RepeatEveryMinutes
		}
		if _, ok := bs.ParsePromptTime(at); !ok {
			continue
		}
		if round, ok := bs.PromptRound(at, every, now); ok {
			kind := "REMINDER"
			if round == 0 {
				kind = "PROMPT"
			}
			out = append(out, promptCall{r.HostelID, kind, round, at})
		}
	}
	return out
}

func promptMessage(promptTime string, reminder bool) (title, body string) {
	if reminder {
		return "Still waiting on your night status", "You have not told your hostel where you are tonight. Answer here — you do not need to open the app."
	}
	at := promptTime
	if m, ok := bs.ParsePromptTime(promptTime); ok {
		at = bs.FormatPromptTime(m)
	}
	return "Are you in the hostel tonight?", "Your hostel checks in at " + at + ". Answer here — you do not need to open the app."
}

// RunNightPrompts is runNightStatusPrompts (the night-status-prompt job): each
// live hostel's residents who have not answered tonight are asked, the first
// round with bell buttons and later rounds by push alone. The unique (hostel,
// night, kind) row is each round's lock.
func (s *Service) RunNightPrompts(ctx context.Context, now time.Time) (ordered.Map, error) {
	hc, err := s.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"APPROVED", "PUBLISHED"}}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hostels []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := hc.All(ctx, &hostels); err != nil {
		return nil, err
	}
	sc, err := s.DB.Collection("hostelsettings").Find(ctx, bson.D{}, options.Find().SetProjection(bson.D{{Key: "attendance.nightStatus", Value: 1}, {Key: "hostelId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var settings []nightSetting
	if err := sc.All(ctx, &settings); err != nil {
		return nil, err
	}
	byHostel := map[bson.ObjectID]nightSetting{}
	for _, r := range settings {
		byHostel[r.HostelID] = r
	}
	rows := make([]nightSetting, 0, len(hostels))
	for _, h := range hostels {
		r, ok := byHostel[h.ID]
		if !ok {
			r = nightSetting{HostelID: h.ID}
		}
		rows = append(rows, r)
	}
	calls := duePrompts(rows, now)
	zero := ordered.Map{{Key: "due", Value: 0}, {Key: "residents", Value: 0}, {Key: "sent", Value: 0}, {Key: "skipped", Value: 0}}
	if len(calls) == 0 {
		return zero, nil
	}
	night := bs.NightKey(now)
	ids := make(bson.A, len(calls))
	for i, c := range calls {
		ids[i] = c.hostelID
	}
	rc, err := s.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"},
		{Key: "userId", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}}}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "userId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var residents []struct {
		ID       bson.ObjectID  `bson:"_id"`
		HostelID bson.ObjectID  `bson:"hostelId"`
		UserID   *bson.ObjectID `bson:"userId"`
	}
	if err := rc.All(ctx, &residents); err != nil {
		return nil, err
	}
	ac, err := s.DB.Collection("nightstatuses").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "night", Value: night}},
		options.Find().SetProjection(bson.D{{Key: "residentId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var answered []struct {
		ResidentID bson.ObjectID `bson:"residentId"`
	}
	if err := ac.All(ctx, &answered); err != nil {
		return nil, err
	}
	done := map[bson.ObjectID]bool{}
	for _, a := range answered {
		done[a.ResidentID] = true
	}
	toAsk := map[bson.ObjectID][]string{}
	for _, r := range residents {
		if r.UserID != nil && !done[r.ID] {
			toAsk[r.HostelID] = append(toAsk[r.HostelID], r.UserID.Hex())
		}
	}
	prompts := s.DB.Collection("nightstatusprompts")
	sent, skipped, reached := 0, 0, 0
	for _, c := range calls {
		users := toAsk[c.hostelID]
		if len(users) == 0 {
			skipped++
			continue
		}
		n, err := prompts.CountDocuments(ctx, bson.D{{Key: "hostelId", Value: c.hostelID}, {Key: "night", Value: night}}, options.Count().SetLimit(1))
		if err != nil {
			return nil, err
		}
		first := n == 0
		kind := "PROMPT"
		if c.round > 0 {
			kind = "REMINDER_" + strconv.Itoa(c.round)
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		if _, err := prompts.InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectIDFromTimestamp(at)}, {Key: "hostelId", Value: c.hostelID}, {Key: "night", Value: night},
			{Key: "kind", Value: kind}, {Key: "round", Value: c.round}, {Key: "promptTime", Value: c.promptTime}, {Key: "notifiedCount", Value: len(users)},
			{Key: "sentAt", Value: at}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
			if !mongo.IsDuplicateKeyError(err) {
				slog.WarnContext(ctx, "Night prompt round not claimed", "hostelId", c.hostelID.Hex(), "error", err)
			}
			skipped++
			continue
		}
		title, body := promptMessage(c.promptTime, !first)
		data := ordered.Map{{Key: "kind", Value: c.kind}, {Key: "night", Value: night}, {Key: "promptTime", Value: c.promptTime}}
		hostel := c.hostelID.Hex()
		if first {
			for _, u := range users {
				if _, err := s.Notify.CreateInApp(ctx, notifications.Input{Actions: nightActions, Body: body, Category: "NIGHT_STATUS", Data: data, HostelID: hostel,
					NoPush: true, Priority: "NORMAL", Title: title, UserID: u}); err != nil {
					return nil, err
				}
			}
		}
		byUser := map[string]map[string]any{}
		for _, u := range users {
			token, err := s.answerToken(hostel, night, u, now)
			if err != nil {
				return nil, err
			}
			byUser[u] = map[string]any{"answerPath": nightStatusAnswerPath, "answerToken": token}
		}
		if s.Notify.Push != nil {
			res := s.Notify.Push.ToUsers(ctx, users, push.Payload{Body: body, Category: "NIGHT_STATUS", CategoryID: nightStatusCategory,
				Data: map[string]any{"kind": c.kind, "night": night, "promptTime": c.promptTime}, DataByUser: byUser, HostelID: hostel, Priority: "NORMAL", Title: title})
			reached += res.Sent
		}
		sent++
	}
	return ordered.Map{{Key: "due", Value: len(calls)}, {Key: "residents", Value: reached}, {Key: "sent", Value: sent}, {Key: "skipped", Value: skipped}}, nil
}

var nightActions = []notifications.Action{
	{Endpoint: "/api/v1/resident/night-status", Key: "INSIDE_HOSTEL", Label: "Inside", Method: "POST",
		Payload: ordered.Map{{Key: "source", Value: "PUSH_ACTION"}, {Key: "status", Value: "INSIDE_HOSTEL"}}, Tone: "primary"},
	{Endpoint: "/api/v1/resident/night-status", Key: "OUTSIDE_HOSTEL", Label: "Outside", Method: "POST",
		Payload: ordered.Map{{Key: "source", Value: "PUSH_ACTION"}, {Key: "status", Value: "OUTSIDE_HOSTEL"}}},
}

// answerToken is nightAnswerData's token: answers tonight from the shade, no
// sooner than a minute's life.
func (s *Service) answerToken(hostelID, night, userID string, now time.Time) (string, error) {
	ends, err := bs.NightEndsAt(night)
	if err != nil {
		return "", err
	}
	ttl := max(60*time.Second, ends.Sub(now).Truncate(time.Second))
	return s.Tokens.SignPurpose(auth.PurposeInput{UserID: userID, Purpose: auth.NightStatusAnswer, TTL: ttl, Claims: map[string]string{"hostelId": hostelID, "night": night}})
}
