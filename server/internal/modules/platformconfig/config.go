// Package platformconfig is modules/platform-config: the website's site-config
// sections and the operations knobs, each a `platformsettings` row re-parsed on
// read through the same zod schema TS uses (schemas.json, written by
// testdata/vectors/generate.ts — never edit it by hand).
package platformconfig

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/bytedance/sonic"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

//go:embed schemas.json
var schemasJSON []byte

// Sections is SITE_CONFIG_SECTIONS, in declared order.
// defaultOrder is DEFAULT_SITE_CONFIG's key order, which the assembled config keeps
// (a stored section replaces its default in place).
var defaultOrder = []string{"apps", "announcement", "email", "content", "facilities", "features", "hero", "identity", "issuer", "legal",
	"lifetime", "logs", "locations", "plans", "appNotice", "questionCall", "seo", "social", "stats", "trustPoints"}

var Sections = []string{"announcement", "appNotice", "apps", "content", "email", "facilities", "features", "hero",
	"identity", "issuer", "legal", "lifetime", "locations", "logs", "plans", "questionCall", "seo", "social", "stats", "trustPoints"}

var (
	schemas  map[string]*zschema.Desc
	defaults ordered.Map
)

func init() {
	var file struct {
		Sections map[string]*zschema.Desc `json:"sections"`
		Defaults json.RawMessage          `json:"defaults"`
	}
	if err := json.Unmarshal(schemasJSON, &file); err != nil {
		panic(err)
	}
	for name, d := range file.Sections {
		if err := d.Prepare(); err != nil {
			panic(name + ": " + err.Error())
		}
	}
	v, err := ordered.FromJSON(file.Defaults)
	if err != nil {
		panic(err)
	}
	schemas, defaults = file.Sections, v.(ordered.Map)
}

// Default is a section's shipped value (a fresh copy).
func Default(section string) any {
	v, _ := defaults.Get(section)
	return zschema.Clone(v)
}

type Service struct {
	db *mongo.Database
	// TTL is how long this instance trusts what it read; 0 = read every time.
	TTL time.Duration

	mu     sync.Mutex
	cached ordered.Map
	at     time.Time
	rows   map[string]rowMemo // single sections, same lifetime as cached (P11-17)
}

type rowMemo struct {
	row   settingRow
	found bool
	at    time.Time
}

func New(db *mongo.Database) *Service { return &Service{db: db, TTL: cacheFor} }

// cacheFor is getSiteConfig's per-instance memo: the staleness a platform admin
// sees after saving on another instance.
const cacheFor = time.Minute

type settingRow struct {
	Key   string        `bson:"key"`
	Value bson.RawValue `bson:"value"`
}

// coerce is coerceSection: a stored value that no longer parses falls back to
// the shipped default; a saved plans catalogue gains services shipped since.
func coerce(section string, value any) any {
	out, ok := schemas[section].Parse(value)
	if !ok {
		return Default(section)
	}
	if section == "plans" {
		saved := out.(ordered.Map)
		services, _ := saved.Get("services")
		have := map[any]bool{}
		list, _ := services.([]any)
		for _, s := range list {
			slug, _ := s.(ordered.Map).Get("slug")
			have[slug] = true
		}
		def, _ := Default("plans").(ordered.Map).Get("services")
		added := false
		for _, s := range def.([]any) {
			if slug, _ := s.(ordered.Map).Get("slug"); !have[slug] {
				list, added = append(list, s), true
			}
		}
		if added {
			saved = saved.Set("services", list)
		}
		return saved
	}
	return out
}

func stored(v bson.RawValue) any {
	if v.Type == 0 { // `value` missing on the row: zod sees undefined
		return ordered.Undefined
	}
	return ordered.FromBSON(v)
}

// SiteConfig is getSiteConfig: every section, stored where saved, else default.
func (s *Service) SiteConfig(ctx context.Context) (ordered.Map, error) {
	s.mu.Lock()
	if s.cached != nil && time.Since(s.at) < s.TTL {
		c := s.cached
		s.mu.Unlock()
		return c, nil
	}
	s.mu.Unlock()
	cur, err := s.db.Collection("platformsettings").Find(ctx, bson.D{{Key: "key", Value: bson.D{{Key: "$in", Value: Sections}}}})
	if err != nil {
		return nil, err
	}
	var rows []settingRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	config := make(ordered.Map, 0, len(defaultOrder))
	for _, name := range defaultOrder {
		config = append(config, ordered.Pair{Key: name, Value: Default(name)})
	}
	for _, r := range rows {
		if schemas[r.Key] != nil {
			config = config.Set(r.Key, coerce(r.Key, stored(r.Value)))
		}
	}
	s.mu.Lock()
	s.cached, s.at = config, time.Now()
	s.mu.Unlock()
	return config, nil
}

// Invalidate drops the memo (invalidateSiteConfigCache).
func (s *Service) Invalidate() {
	s.mu.Lock()
	s.cached = nil
	s.rows = nil
	s.mu.Unlock()
}

// row is one platformsettings row, memoised per instance for cacheFor like the
// whole config (TS read it on every call: one Mongo trip per request, P11-17).
// The raw value is kept, so every caller parses its own copy.
func (s *Service) row(ctx context.Context, key string) (settingRow, bool, error) {
	s.mu.Lock()
	m, ok := s.rows[key]
	s.mu.Unlock()
	if ok && time.Since(m.at) < s.TTL {
		return m.row, m.found, nil
	}
	var row settingRow
	err := s.db.Collection("platformsettings").FindOne(ctx, bson.D{{Key: "key", Value: key}}).Decode(&row)
	found := err == nil
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return row, false, err
	}
	s.mu.Lock()
	if s.rows == nil {
		s.rows = map[string]rowMemo{}
	}
	s.rows[key] = rowMemo{row, found, time.Now()}
	s.mu.Unlock()
	return row, found, nil
}

// Section is getSiteConfigSection: one row, stored where saved, else default.
func (s *Service) Section(ctx context.Context, section string) (any, error) {
	row, found, err := s.row(ctx, section)
	if err != nil {
		return nil, err
	}
	if !found {
		return Default(section), nil
	}
	return coerce(section, stored(row.Value)), nil
}

// Decode turns a parsed section into a typed struct, for code that reads fields.
func Decode(v any, into any) error {
	b, err := sonic.ConfigDefault.Marshal(v)
	if err != nil {
		return err
	}
	return sonic.ConfigDefault.Unmarshal(b, into)
}

// Operations is getOperationsConfig: any failure (read or parse) is the defaults.
func (s *Service) Operations(ctx context.Context) ordered.Map {
	if row, found, err := s.row(ctx, "operations"); err == nil && found {
		if out, ok := schemas["operations"].Parse(stored(row.Value)); ok {
			return out.(ordered.Map)
		}
	}
	return Default("operations").(ordered.Map)
}

// OperationsConfig is the typed view of the operations knobs.
type OperationsConfig struct {
	MaxAttendanceRetentionDays int            `json:"maxAttendanceRetentionDays"`
	MaxInsideZoneRadiusMeters  int            `json:"maxInsideZoneRadiusMeters"`
	MaxNearbyZoneRadiusMeters  int            `json:"maxNearbyZoneRadiusMeters"`
	FoodReadyCooldownMinutes   int            `json:"foodReadyCooldownMinutes"`
	ComplaintSlaHours          int            `json:"complaintSlaHours"`
	PaymentReminderDaysBefore  int            `json:"paymentReminderDaysBefore"`
	SubscriptionDueGraceDays   int            `json:"subscriptionDueGraceDays"`
	TrialDays                  int            `json:"trialDays"`
	LeaveHoldMinDays           int            `json:"leaveHoldMinDays"`
	LeaveHoldMaxDays           int            `json:"leaveHoldMaxDays"`
	CollectionQrURL            string         `json:"collectionQrUrl"`
	CollectionQrLabel          string         `json:"collectionQrLabel"`
	TeamCommissionPercent      float64        `json:"teamCommissionPercent"`
	TeamSetupFee               int            `json:"teamSetupFee"`
	SendComplaintEmails        bool           `json:"sendComplaintEmails"`
	QrActivationExpiryDays     int            `json:"qrActivationExpiryDays"`
	ReceiptNumberPrefix        string         `json:"receiptNumberPrefix"`
	SendNoticeEmails           bool           `json:"sendNoticeEmails"`
	SendPaymentEmails          bool           `json:"sendPaymentEmails"`
	MaintenanceMinimumCharges  map[string]int `json:"maintenanceMinimumCharges"`
}

func (s *Service) OperationsTyped(ctx context.Context) OperationsConfig {
	var out OperationsConfig
	_ = Decode(s.Operations(ctx), &out)
	return out
}

// Store is getStoreConfig: the supply store's knobs; any failure is the defaults.
func (s *Service) Store(ctx context.Context) ordered.Map {
	if row, found, err := s.row(ctx, "store"); err == nil && found {
		if out, ok := schemas["store"].Parse(stored(row.Value)); ok {
			return out.(ordered.Map)
		}
	}
	return Default("store").(ordered.Map)
}

// Parse is a section's schema over a stored value; false = it does not parse
// (or no such section).
func Parse(section string, v any) (any, bool) {
	d := schemas[section]
	if d == nil {
		return nil, false
	}
	return d.Parse(v)
}

// ParseStore is storeConfigSchema.parse over a merged value (saveStoreConfig).
func ParseStore(v any) (ordered.Map, bool) {
	out, ok := schemas["store"].Parse(v)
	if !ok {
		return nil, false
	}
	return out.(ordered.Map), true
}
