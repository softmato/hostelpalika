package hostelrooms

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Service is hostel-rooms.service.
type Service struct {
	DB     *mongo.Database
	Cap    *Capacity
	Notify *notifications.Service
}

var live = bson.A{"ACTIVE", "PENDING", "SUSPENDED"}

func roomErr(msg, code string, status int) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

type roomRow struct {
	ID       bson.ObjectID `bson:"_id"`
	Beds     int           `bson:"beds"`
	Floor    int           `bson:"floor"`
	Number   string        `bson:"number"`
	Position *float64      `bson:"position"`
	RoomType string        `bson:"roomType"`
}

type liveResident struct {
	ID       bson.ObjectID  `bson:"_id"`
	First    string         `bson:"firstName"`
	Last     string         `bson:"lastName"`
	MoveIn   *time.Time     `bson:"moveInDate"`
	PhotoID  *bson.ObjectID `bson:"photoAssetId"`
	RoomID   *bson.ObjectID `bson:"roomId"`
	RoomType string         `bson:"roomType"`
	UserID   *bson.ObjectID `bson:"userId"`
}

func (r *liveResident) name() string { return strings.TrimSpace(r.First + " " + r.Last) }

// PhotoPath is residentPhotoPath: the staff app's face for an admission-form photo.
func PhotoPath(residentID, assetID bson.ObjectID) string {
	return "/api/v1/hostel-admin/residents/" + residentID.Hex() + "/photo?v=" + assetID.Hex()
}

// Tracking is isRoomTracking: the owner's choice, else on only for a hostel
// that already numbered rooms.
func (s *Service) Tracking(ctx context.Context, hostel bson.ObjectID) (bool, error) {
	var row struct {
		Tracking *bool `bson:"roomTracking"`
	}
	err := s.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomTracking", Value: 1}})).Decode(&row)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return false, err
	}
	if row.Tracking != nil {
		return *row.Tracking, nil
	}
	n, err := s.DB.Collection("hostelrooms").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}}, options.Count().SetLimit(1))
	return n > 0, err
}

// roomsCap bounds a floor plan read: far above any hostel, below "all".
const roomsCap = 5000

func (s *Service) loadRooms(ctx context.Context, hostel bson.ObjectID) ([]roomRow, error) {
	cur, err := s.DB.Collection("hostelrooms").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}},
		options.Find().SetProjection(bson.D{{Key: "beds", Value: 1}, {Key: "floor", Value: 1}, {Key: "number", Value: 1}, {Key: "position", Value: 1}, {Key: "roomType", Value: 1}}).SetLimit(roomsCap))
	if err != nil {
		return nil, err
	}
	var rows []roomRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.Floor != b.Floor {
			return a.Floor < b.Floor
		}
		pa, pb := 9007199254740991.0, 9007199254740991.0
		if a.Position != nil {
			pa = *a.Position
		}
		if b.Position != nil {
			pb = *b.Position
		}
		if pa != pb {
			return pa < pb
		}
		return numericCompare(a.Number, b.Number) < 0
	})
	return rows, nil
}

func (s *Service) loadLive(ctx context.Context, hostel bson.ObjectID) ([]liveResident, error) {
	cur, err := s.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: live}}}},
		options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "moveInDate", Value: 1}, {Key: "photoAssetId", Value: 1}, {Key: "roomId", Value: 1}, {Key: "roomType", Value: 1}, {Key: "userId", Value: 1}}).SetLimit(20000))
	if err != nil {
		return nil, err
	}
	var rows []liveResident
	return rows, cur.All(ctx, &rows)
}

// Output shapes, keys in the order TS builds them.
type residentOut struct {
	Due   int64   `json:"due"`
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Photo *string `json:"photo"`
	Since *string `json:"since"`
}

type roomOut struct {
	Beds      int           `json:"beds"`
	Floor     int           `json:"floor"`
	Free      int           `json:"free"`
	ID        string        `json:"id"`
	Number    string        `json:"number"`
	Residents []residentOut `json:"residents"`
	RoomType  string        `json:"roomType"`
}

type extras struct {
	dues   map[bson.ObjectID]int64
	images map[bson.ObjectID]string
}

func viewRooms(rooms []roomRow, residents []liveResident, x *extras) []roomOut {
	byRoom := map[bson.ObjectID][]*liveResident{}
	for i := range residents {
		if r := &residents[i]; r.RoomID != nil {
			byRoom[*r.RoomID] = append(byRoom[*r.RoomID], r)
		}
	}
	out := make([]roomOut, len(rooms))
	for i, room := range rooms {
		in := byRoom[room.ID]
		o := roomOut{Beds: room.Beds, Floor: room.Floor, Free: max(room.Beds-len(in), 0), ID: room.ID.Hex(), Number: room.Number, Residents: make([]residentOut, len(in)), RoomType: room.RoomType}
		for k, r := range in {
			ro := residentOut{ID: r.ID.Hex(), Name: r.name()}
			if x != nil {
				ro.Due = x.dues[r.ID]
				if r.UserID != nil {
					if img, ok := x.images[*r.UserID]; ok {
						ro.Photo = &img
					}
				}
			}
			if ro.Photo == nil && r.PhotoID != nil {
				p := PhotoPath(r.ID, *r.PhotoID)
				ro.Photo = &p
			}
			if r.MoveIn != nil {
				t := httpx.ISO(*r.MoveIn)
				ro.Since = &t
			}
			o.Residents[k] = ro
		}
		out[i] = o
	}
	return out
}

// DeriveCounts is deriveTypeCounts: once any room is laid out the plan is the
// only truth, and free beds are counted per type.
func DeriveCounts(cs []Config, rooms []roomRow, residents []liveResident) []Config {
	out := make([]Config, len(cs))
	for i, c := range cs {
		var n, beds float64
		for _, r := range rooms {
			if r.RoomType == c.RoomType() {
				n++
				beds += float64(r.Beds)
			}
		}
		living := 0.0
		for _, r := range residents {
			if r.RoomType == c.RoomType() {
				living++
			}
		}
		next := append(Config(nil), c...)
		if n > 0 {
			next.set("bedsPerRoom", jsNum(max(1, float64(int64(beds/n+0.5)))))
		}
		next.set("rooms", jsNum(n))
		next.set("vacantBeds", jsNum(max(beds-living, 0)))
		out[i] = next
	}
	return out
}

func sameCounts(a, b []Config) bool {
	for i := range a {
		if i >= len(b) || a[i].rooms() != b[i].rooms() || a[i].vacant() != b[i].vacant() || a[i].bedsEach() != b[i].bedsEach() {
			return false
		}
	}
	return true
}

type totalsOut struct {
	Beds  float64 `json:"beds"`
	Free  float64 `json:"free"`
	Rooms float64 `json:"rooms"`
}

type unassignedOut struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	RoomType string `json:"roomType,omitempty"`
}

// Layout is the answer of getRoomLayout and of every room write.
type Layout struct {
	// FloorNames is only there once the owner named a floor, so a hostel that never did keeps the layout it had.
	FloorNames      map[string]string `json:"floorNames,omitempty"`
	PendingRequests int64             `json:"pendingRequests"`
	Rooms           []roomOut         `json:"rooms"`
	RoomTypes       []string          `json:"roomTypes"`
	Totals          totalsOut         `json:"totals"`
	Tracking        bool              `json:"tracking"`
	Unassigned      []unassignedOut   `json:"unassigned"`
}

// dues is outstandingByResident for one hostel: unsettled invoices, what is still owed.
func (s *Service) dues(ctx context.Context, hostel bson.ObjectID) (map[bson.ObjectID]int64, error) {
	cur, err := s.DB.Collection("invoices").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}}}},
		bson.D{{Key: "$lookup", Value: bson.D{{Key: "as", Value: "balance"}, {Key: "foreignField", Value: "invoiceId"}, {Key: "from", Value: "invoicebalances"}, {Key: "localField", Value: "_id"}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$residentId"}, {Key: "outstanding", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$max", Value: bson.A{
			bson.D{{Key: "$subtract", Value: bson.A{"$totalAmount", bson.D{{Key: "$ifNull", Value: bson.A{bson.D{{Key: "$arrayElemAt", Value: bson.A{"$balance.settledAmount", 0}}}, 0}}}}}}, 0}}}}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID          *bson.ObjectID `bson:"_id"`
		Outstanding float64        `bson:"outstanding"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID]int64{}
	for _, r := range rows {
		if r.ID != nil {
			out[*r.ID] = int64(r.Outstanding)
		}
	}
	return out, nil
}

// Layout is getRoomLayout.
func (s *Service) Layout(ctx context.Context, hostel bson.ObjectID) (*Layout, error) {
	rooms, err := s.loadRooms(ctx, hostel)
	if err != nil {
		return nil, err
	}
	residents, err := s.loadLive(ctx, hostel)
	if err != nil {
		return nil, err
	}
	tracking, err := s.Tracking(ctx, hostel)
	if err != nil {
		return nil, err
	}
	floorNames, err := s.floorNames(ctx, hostel)
	if err != nil {
		return nil, err
	}
	var h struct {
		Rooms []Config `bson:"roomConfigurations"`
	}
	err = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	pending, err := s.DB.Collection("roomchangerequests").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "PENDING"}})
	if err != nil {
		return nil, err
	}
	configs := h.Rooms
	planned := tracking && len(rooms) > 0
	derived := configs
	if planned {
		derived = DeriveCounts(configs, rooms, residents)
		// Counts typed before the plan became the truth heal the first time they are opened.
		if !sameCounts(derived, configs) {
			if err := s.Cap.Write(ctx, hostel, derived); err != nil {
				return nil, err
			}
		}
	}
	summary := Summarize(derived)
	roomIDs := map[bson.ObjectID]bool{}
	for _, r := range rooms {
		roomIDs[r.ID] = true
	}
	x := &extras{dues: map[bson.ObjectID]int64{}, images: map[bson.ObjectID]string{}}
	var userIDs bson.A
	roomed := 0
	for _, r := range residents {
		if r.RoomID != nil && roomIDs[*r.RoomID] {
			roomed++
			if r.UserID != nil {
				userIDs = append(userIDs, *r.UserID)
			}
		}
	}
	if roomed > 0 {
		if x.dues, err = s.dues(ctx, hostel); err != nil {
			return nil, err
		}
		if len(userIDs) > 0 {
			cur, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: userIDs}}}}, options.Find().SetProjection(bson.D{{Key: "image", Value: 1}}))
			if err != nil {
				return nil, err
			}
			var us []struct {
				ID    bson.ObjectID `bson:"_id"`
				Image *string       `bson:"image"`
			}
			if err := cur.All(ctx, &us); err != nil {
				return nil, err
			}
			for _, u := range us {
				if u.Image != nil && *u.Image != "" {
					x.images[u.ID] = *u.Image
				}
			}
		}
	}
	out := &Layout{FloorNames: floorNames, PendingRequests: pending, Rooms: viewRooms(rooms, residents, x), RoomTypes: make([]string, len(configs)), Tracking: tracking, Unassigned: []unassignedOut{}}
	for i, c := range configs {
		out.RoomTypes[i] = c.RoomType()
	}
	if tracking {
		var beds float64
		for _, r := range rooms {
			beds += float64(r.Beds)
		}
		out.Totals = totalsOut{Beds: beds, Rooms: float64(len(rooms))}
		if planned {
			out.Totals.Free = summary.VacantBeds
		}
	} else {
		out.Totals = totalsOut{Beds: summary.TotalBeds, Free: summary.VacantBeds, Rooms: summary.TotalRooms}
	}
	for _, r := range residents {
		if r.RoomID == nil || !roomIDs[*r.RoomID] {
			out.Unassigned = append(out.Unassigned, unassignedOut{r.ID.Hex(), r.name(), r.RoomType})
		}
	}
	return out, nil
}

// syncTypeCounts re-derives the listing's per-type counts from the floor plan.
// A hostel with no rooms keeps what was typed.
func (s *Service) syncTypeCounts(ctx context.Context, hostel bson.ObjectID) error {
	rooms, err := s.loadRooms(ctx, hostel)
	if err != nil {
		return err
	}
	residents, err := s.loadLive(ctx, hostel)
	if err != nil {
		return err
	}
	var h struct {
		Rooms []Config `bson:"roomConfigurations"`
	}
	err = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) || len(rooms) == 0 {
		return nil
	}
	if err != nil {
		return err
	}
	return s.Cap.Write(ctx, hostel, DeriveCounts(h.Rooms, rooms, residents))
}

func (s *Service) assertType(ctx context.Context, hostel bson.ObjectID, roomType string) error {
	cs, err := s.Cap.Load(ctx, hostel)
	if err != nil && httpx.Code(err) != "HOSTEL_NOT_FOUND" {
		return err
	}
	for _, c := range cs {
		if c.RoomType() == roomType {
			return nil
		}
	}
	return roomErr(`"`+roomType+`" is not one of this hostel's room types. Add it under room types first.`, "ROOM_TYPE_UNKNOWN", http.StatusUnprocessableEntity)
}

// AddIn is addRoomsSchema.
type AddIn struct {
	Beds, Floor int
	Numbers     []string
	RoomType    string
}

// Add is addRooms: a floor's rooms in one go.
func (s *Service) Add(ctx context.Context, hostel bson.ObjectID, in AddIn, by bson.ObjectID) (*Layout, error) {
	seen := map[string]bool{}
	var numbers []string
	for _, n := range in.Numbers {
		if n = strings.TrimSpace(n); !seen[n] {
			seen[n] = true
			numbers = append(numbers, n)
		}
	}
	if err := s.assertType(ctx, hostel, in.RoomType); err != nil {
		return nil, err
	}
	coll := s.DB.Collection("hostelrooms")
	cur, err := coll.Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "number", Value: bson.D{{Key: "$in", Value: numbers}}}}, options.Find().SetProjection(bson.D{{Key: "number", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var taken []struct {
		Number string `bson:"number"`
	}
	if err := cur.All(ctx, &taken); err != nil {
		return nil, err
	}
	if len(taken) > 0 {
		list := make([]string, len(taken))
		for i, t := range taken {
			list[i] = t.Number
		}
		return nil, roomErr("Room "+strings.Join(list, ", ")+" already exists.", "ROOM_NUMBER_TAKEN", http.StatusConflict)
	}
	now := time.Now().UTC()
	docs := make([]any, len(numbers))
	for i, n := range numbers {
		docs[i] = bson.D{{Key: "hostelId", Value: hostel}, {Key: "floor", Value: int32(in.Floor)}, {Key: "number", Value: n}, {Key: "roomType", Value: in.RoomType}, {Key: "beds", Value: int32(in.Beds)},
			{Key: "isDeleted", Value: false}, {Key: "createdBy", Value: by}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: int32(0)}}
	}
	if _, err := coll.InsertMany(ctx, docs); err != nil {
		if mongo.IsDuplicateKeyError(err) { // two adds raced past the check above
			return nil, roomErr("Room "+strings.Join(numbers, ", ")+" already exists.", "ROOM_NUMBER_TAKEN", http.StatusConflict)
		}
		return nil, err
	}
	if err := s.syncTypeCounts(ctx, hostel); err != nil {
		return nil, err
	}
	return s.Layout(ctx, hostel)
}

func (s *Service) findRoom(ctx context.Context, hostel bson.ObjectID, id bson.ObjectID) (*roomRow, error) {
	var room roomRow
	err := s.DB.Collection("hostelrooms").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}}).Decode(&room)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, roomErr("Room was not found.", "ROOM_NOT_FOUND", http.StatusNotFound)
	}
	return &room, err
}

func (s *Service) residentsIn(ctx context.Context, room bson.ObjectID) (int64, error) {
	return s.DB.Collection("residents").CountDocuments(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "roomId", Value: room}, {Key: "status", Value: bson.D{{Key: "$in", Value: live}}}})
}

// TypeChangeRefusal is typeChangeRefusal: why an occupied room cannot take a type, or "".
func TypeChangeRefusal(number string, living int64, roomType string, beds int) string {
	if int(living) <= beds {
		return ""
	}
	extra := int(living) - beds
	bedWord, who := "beds", "people"
	if beds == 1 {
		bedWord = "bed"
	}
	if extra == 1 {
		who = "person"
	}
	return numStr(living) + " people live in Room " + number + "; a " + TypeLabel(roomType) + " has " + numStr(int64(beds)) + " " + bedWord + ". Move " + numStr(int64(extra)) + " " + who + " out first."
}

func numStr(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

// UpdateIn is updateRoomSchema; nil fields are absent.
type UpdateIn struct {
	Beds, Floor      *int
	Number, RoomType *string
}

// Update is updateRoom.
func (s *Service) Update(ctx context.Context, hostel, roomID bson.ObjectID, in UpdateIn, by bson.ObjectID) (*Layout, error) {
	room, err := s.findRoom(ctx, hostel, roomID)
	if err != nil {
		return nil, err
	}
	living, err := s.residentsIn(ctx, room.ID)
	if err != nil {
		return nil, err
	}
	if in.Beds != nil && int64(*in.Beds) < living {
		return nil, roomErr(numStr(living)+" people live in Room "+room.Number+". It needs at least "+numStr(living)+" beds.", "ROOM_TOO_SMALL", http.StatusConflict)
	}
	retyped := in.RoomType != nil && *in.RoomType != room.RoomType
	var beds *int
	if in.Beds != nil {
		beds = in.Beds
	}
	if retyped && in.Beds == nil {
		b := BedsFor(*in.RoomType)
		beds = &b
	}
	if retyped {
		if err := s.assertType(ctx, hostel, *in.RoomType); err != nil {
			return nil, err
		}
		use := room.Beds
		if beds != nil {
			use = *beds
		}
		if msg := TypeChangeRefusal(room.Number, living, *in.RoomType, use); msg != "" {
			return nil, roomErr(msg, "ROOM_TOO_SMALL", http.StatusConflict)
		}
	}
	if in.Number != nil && *in.Number != room.Number {
		n, err := s.DB.Collection("hostelrooms").CountDocuments(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: room.ID}}}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "number", Value: *in.Number}}, options.Count().SetLimit(1))
		if err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, roomErr("Room "+*in.Number+" already exists.", "ROOM_NUMBER_TAKEN", http.StatusConflict)
		}
	}
	now := time.Now().UTC()
	set := bson.D{}
	if beds != nil {
		set = append(set, bson.E{Key: "beds", Value: int32(*beds)})
	}
	if in.Floor != nil {
		set = append(set, bson.E{Key: "floor", Value: int32(*in.Floor)})
	}
	if in.Number != nil {
		set = append(set, bson.E{Key: "number", Value: *in.Number})
	}
	if in.RoomType != nil {
		set = append(set, bson.E{Key: "roomType", Value: *in.RoomType})
	}
	set = append(set, bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "updatedAt", Value: now})
	if _, err := s.DB.Collection("hostelrooms").UpdateOne(ctx, bson.D{{Key: "_id", Value: room.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return nil, roomErr("Room "+*in.Number+" already exists.", "ROOM_NUMBER_TAKEN", http.StatusConflict)
		}
		return nil, err
	}
	// The number and floor are copied onto residents so lists need no join.
	if in.Number != nil || in.Floor != nil {
		floor, number := room.Floor, room.Number
		if in.Floor != nil {
			floor = *in.Floor
		}
		if in.Number != nil {
			number = *in.Number
		}
		if _, err := s.DB.Collection("residents").UpdateMany(ctx, bson.D{{Key: "roomId", Value: room.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "floor", Value: int32(floor)}, {Key: "roomNumber", Value: number}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, err
		}
	}
	// Whoever lives there now lives in the new type; rent follows it from the next bill.
	if retyped {
		set := bson.D{}
		if bt := finance.NormalizeBedType(*in.RoomType); bt != "" {
			set = append(set, bson.E{Key: "bedType", Value: bt})
		}
		set = append(set, bson.E{Key: "roomType", Value: *in.RoomType}, bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "updatedAt", Value: now})
		if _, err := s.DB.Collection("residents").UpdateMany(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "roomId", Value: room.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: live}}}}, bson.D{{Key: "$set", Value: set}}); err != nil {
			return nil, err
		}
	}
	if err := s.syncTypeCounts(ctx, hostel); err != nil {
		return nil, err
	}
	return s.Layout(ctx, hostel)
}

// Delete is deleteRoom.
func (s *Service) Delete(ctx context.Context, hostel, roomID, by bson.ObjectID) (*Layout, error) {
	room, err := s.findRoom(ctx, hostel, roomID)
	if err != nil {
		return nil, err
	}
	living, err := s.residentsIn(ctx, room.ID)
	if err != nil {
		return nil, err
	}
	if living > 0 {
		return nil, roomErr(numStr(living)+" people live in Room "+room.Number+". Move them first.", "ROOM_OCCUPIED", http.StatusConflict)
	}
	now := time.Now().UTC()
	if _, err := s.DB.Collection("hostelrooms").UpdateOne(ctx, bson.D{{Key: "_id", Value: room.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("roomchangerequests").UpdateMany(ctx, bson.D{{Key: "status", Value: "PENDING"}, {Key: "toRoomId", Value: room.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	if err := s.syncTypeCounts(ctx, hostel); err != nil {
		return nil, err
	}
	return s.Layout(ctx, hostel)
}

// floorNames is loadFloorNames: the owner's floor names by floor number, nil when there are none.
func (s *Service) floorNames(ctx context.Context, hostel bson.ObjectID) (map[string]string, error) {
	var row struct {
		Names map[string]string `bson:"floorNames"`
	}
	err := s.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "floorNames", Value: 1}})).Decode(&row)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if len(row.Names) == 0 {
		return nil, nil
	}
	return row.Names, nil
}

// SetFloorName is setFloorName: an empty name puts the floor's ordinal back.
func (s *Service) SetFloorName(ctx context.Context, hostel bson.ObjectID, floor int, name string, by bson.ObjectID) (*Layout, error) {
	now := time.Now().UTC()
	key := "floorNames." + numStr(int64(floor))
	set := bson.D{{Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: now}}
	update := bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: by}, {Key: "createdAt", Value: now}, {Key: "hostelId", Value: hostel}, {Key: "__v", Value: int32(0)}}}}
	if name == "" {
		update = append(update, bson.E{Key: "$set", Value: set}, bson.E{Key: "$unset", Value: bson.D{{Key: key, Value: ""}}})
	} else {
		update = append(update, bson.E{Key: "$set", Value: append(set, bson.E{Key: key, Value: name})})
	}
	if _, err := s.DB.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, update, options.UpdateOne().SetUpsert(true)); err != nil {
		return nil, err
	}
	return s.Layout(ctx, hostel)
}

// SetTracking is setRoomTracking.
func (s *Service) SetTracking(ctx context.Context, hostel bson.ObjectID, enabled bool, by bson.ObjectID) (*Layout, error) {
	now := time.Now().UTC()
	_, err := s.DB.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{
		{Key: "$set", Value: bson.D{{Key: "roomTracking", Value: enabled}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: now}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: by}, {Key: "createdAt", Value: now}, {Key: "hostelId", Value: hostel}, {Key: "__v", Value: int32(0)}}}}, options.UpdateOne().SetUpsert(true))
	if err != nil {
		return nil, err
	}
	// Either way the type counts start from the plan, so the totals do not jump.
	if err := s.syncTypeCounts(ctx, hostel); err != nil {
		return nil, err
	}
	return s.Layout(ctx, hostel)
}

// Order is orderRooms: where the owner dragged a floor's rooms.
func (s *Service) Order(ctx context.Context, hostel bson.ObjectID, floor int, ids []bson.ObjectID) (*Layout, error) {
	models := make([]mongo.WriteModel, len(ids))
	now := time.Now().UTC()
	for i, id := range ids {
		models[i] = mongo.NewUpdateOneModel().SetFilter(bson.D{{Key: "_id", Value: id}, {Key: "floor", Value: floor}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}}).
			SetUpdate(bson.D{{Key: "$set", Value: bson.D{{Key: "position", Value: int32(i)}, {Key: "updatedAt", Value: now}}}})
	}
	if _, err := s.DB.Collection("hostelrooms").BulkWrite(ctx, models); err != nil {
		return nil, err
	}
	return s.Layout(ctx, hostel)
}

// Resolve is resolveRoom: this hostel's room with a free bed. ignore is the
// resident being moved, who must not count against their own new room.
func (s *Service) Resolve(ctx context.Context, hostel bson.ObjectID, roomID bson.ObjectID, ignore *bson.ObjectID) (*roomRow, error) {
	var room roomRow
	err := s.DB.Collection("hostelrooms").FindOne(ctx, bson.D{{Key: "_id", Value: roomID}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}},
		options.FindOne().SetProjection(bson.D{{Key: "beds", Value: 1}, {Key: "floor", Value: 1}, {Key: "number", Value: 1}, {Key: "roomType", Value: 1}})).Decode(&room)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, roomErr("That room is not in this hostel.", "ROOM_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}
	q := bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "roomId", Value: room.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: live}}}}
	if ignore != nil {
		q = append(q, bson.E{Key: "_id", Value: bson.D{{Key: "$ne", Value: *ignore}}})
	}
	living, err := s.DB.Collection("residents").CountDocuments(ctx, q)
	if err != nil {
		return nil, err
	}
	if int(living) >= room.Beds {
		return nil, roomErr("Room "+room.Number+" is full.", "ROOM_FULL", http.StatusConflict)
	}
	return &room, nil
}

// Room is the part of a room a move answers with.
type Room struct {
	Floor    int    `json:"floor"`
	ID       string `json:"id"`
	Number   string `json:"number"`
	RoomType string `json:"roomType"`
}

// Move is moveResidentToRoom: the one move a warden's change and an approved
// request both make. A different type moves the bed between types.
func (s *Service) Move(ctx context.Context, hostel, residentID bson.ObjectID, roomID bson.ObjectID, by bson.ObjectID) (*Room, error) {
	var res struct {
		ID       bson.ObjectID  `bson:"_id"`
		RoomID   *bson.ObjectID `bson:"roomId"`
		RoomType string         `bson:"roomType"`
	}
	err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: residentID}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: live}}}}).Decode(&res)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, roomErr("Resident was not found.", "RESIDENT_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}
	room, err := s.Resolve(ctx, hostel, roomID, &res.ID)
	if err != nil {
		return nil, err
	}
	if room.RoomType != res.RoomType {
		if err := s.Cap.Move(ctx, hostel, res.RoomType, room.RoomType); err != nil {
			if c := httpx.Code(err); c == "ROOM_TYPE_FULL" || c == "ROOM_TYPE_NOT_FOUND" {
				return nil, roomErr("No free "+TypeLabel(room.RoomType)+" bed is counted for this hostel.", "ROOM_FULL", http.StatusConflict)
			}
			return nil, err
		}
	}
	now := time.Now().UTC()
	set := bson.D{}
	if bt := finance.NormalizeBedType(room.RoomType); bt != "" {
		set = append(set, bson.E{Key: "bedType", Value: bt})
	}
	set = append(set, bson.E{Key: "floor", Value: int32(room.Floor)}, bson.E{Key: "roomId", Value: room.ID}, bson.E{Key: "roomNumber", Value: room.Number}, bson.E{Key: "roomType", Value: room.RoomType},
		bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "updatedAt", Value: now})
	if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: res.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		return nil, err
	}
	// Whatever they had asked for is answered by the move.
	if _, err := s.DB.Collection("roomchangerequests").UpdateMany(ctx, bson.D{{Key: "residentId", Value: res.ID}, {Key: "status", Value: "PENDING"}, {Key: "toRoomId", Value: bson.D{{Key: "$ne", Value: room.ID}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	if room.RoomType != res.RoomType {
		if err := s.syncTypeCounts(ctx, hostel); err != nil {
			return nil, err
		}
	}
	return &Room{room.Floor, room.ID.Hex(), room.Number, room.RoomType}, nil
}

// --- the staff's queue of room changes --------------------------------------

type whereOut struct {
	Floor    int    `json:"floor"`
	Free     int    `json:"free"`
	Number   string `json:"number"`
	RoomType string `json:"roomType"`
}

type who struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Request is one row of listRoomChangeRequests.
type Request struct {
	CreatedAt string    `json:"createdAt"`
	From      *whereOut `json:"from"`
	ID        string    `json:"id"`
	Note      *string   `json:"note"`
	Resident  who       `json:"resident"`
	To        *whereOut `json:"to"`
}

// Requests is listRoomChangeRequests: who wants which bed, oldest first.
func (s *Service) Requests(ctx context.Context, hostel bson.ObjectID) ([]Request, error) {
	cur, err := s.DB.Collection("roomchangerequests").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "PENDING"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(1000))
	if err != nil {
		return nil, err
	}
	var reqs []struct {
		ID         bson.ObjectID  `bson:"_id"`
		CreatedAt  time.Time      `bson:"createdAt"`
		FromRoomID *bson.ObjectID `bson:"fromRoomId"`
		Note       *string        `bson:"note"`
		ResidentID bson.ObjectID  `bson:"residentId"`
		ToRoomID   bson.ObjectID  `bson:"toRoomId"`
	}
	if err := cur.All(ctx, &reqs); err != nil {
		return nil, err
	}
	out := []Request{}
	if len(reqs) == 0 {
		return out, nil
	}
	rooms, err := s.loadRooms(ctx, hostel)
	if err != nil {
		return nil, err
	}
	residents, err := s.loadLive(ctx, hostel)
	if err != nil {
		return nil, err
	}
	views := map[string]roomOut{}
	for _, v := range viewRooms(rooms, residents, nil) {
		views[v.ID] = v
	}
	people := map[bson.ObjectID]*liveResident{}
	for i := range residents {
		people[residents[i].ID] = &residents[i]
	}
	where := func(id *bson.ObjectID) *whereOut {
		if id == nil {
			return nil
		}
		if v, ok := views[id.Hex()]; ok {
			return &whereOut{v.Floor, v.Free, v.Number, v.RoomType}
		}
		return nil
	}
	for _, r := range reqs {
		p := people[r.ResidentID]
		if p == nil {
			continue
		}
		to := r.ToRoomID
		out = append(out, Request{httpx.ISO(r.CreatedAt), where(r.FromRoomID), r.ID.Hex(), r.Note, who{p.ID.Hex(), p.name()}, where(&to)})
	}
	return out, nil
}

// Answer is answerRoomChange.
func (s *Service) Answer(ctx context.Context, hostel, requestID bson.ObjectID, approve bool, reason string, by bson.ObjectID) ([]Request, error) {
	var req struct {
		ID         bson.ObjectID `bson:"_id"`
		ResidentID bson.ObjectID `bson:"residentId"`
		ToRoomID   bson.ObjectID `bson:"toRoomId"`
	}
	err := s.DB.Collection("roomchangerequests").FindOne(ctx, bson.D{{Key: "_id", Value: requestID}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "PENDING"}}).Decode(&req)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, roomErr("That request was already answered.", "REQUEST_CLOSED", http.StatusConflict)
	}
	if err != nil {
		return nil, err
	}
	var room *Room
	if approve {
		if room, err = s.Move(ctx, hostel, req.ResidentID, req.ToRoomID, by); err != nil {
			return nil, err
		}
	}
	now := time.Now().UTC()
	set := bson.D{{Key: "decidedAt", Value: now}, {Key: "decidedBy", Value: by}}
	status := "DECLINED"
	if approve {
		status = "APPROVED"
	} else if reason != "" {
		set = append(set, bson.E{Key: "declineReason", Value: reason})
	}
	set = append(set, bson.E{Key: "status", Value: status}, bson.E{Key: "updatedAt", Value: now})
	// Only the still-pending row: two staff answering at once cannot both win.
	if _, err := s.DB.Collection("roomchangerequests").UpdateOne(ctx, bson.D{{Key: "_id", Value: req.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		return nil, err
	}
	var res struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	err = s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: req.ResidentID}}, options.FindOne().SetProjection(bson.D{{Key: "userId", Value: 1}})).Decode(&res)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if res.UserID != nil {
		in := notifications.Input{Category: "ROOM", Data: ordered.Map{}.Set("type", "ROOM_CHANGE_ANSWERED"), HostelID: hostel.Hex(), UserID: res.UserID.Hex()}
		if room != nil {
			in.Body, in.Title = "You are now in Room "+room.Number+", "+Floor(room.Floor)+".", "Room change confirmed"
		} else {
			in.Body, in.Title = "Your room change was not approved."+reasonTail(reason), "Room change declined"
		}
		_, _ = s.Notify.CreateInApp(ctx, in)
	}
	return s.Requests(ctx, hostel)
}

func reasonTail(reason string) string {
	if reason == "" {
		return ""
	}
	return " " + reason
}
