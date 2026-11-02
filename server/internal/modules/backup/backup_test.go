package backup

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

func TestDriveState(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	h := &Handler{JWTSecret: "s", Now: func() time.Time { return now }}
	v, err := h.signState(oauthState{now.Add(stateTTL).UnixMilli(), "app", "h", "u"})
	if err != nil {
		t.Fatal(err)
	}
	if s := h.readState(v); s == nil || s.F != "app" || s.H != "h" {
		t.Fatalf("round trip: %+v", s)
	}
	if h.readState(v+"x") != nil || h.readState("e30.x") != nil {
		t.Fatal("tampered state accepted")
	}
	h.Now = func() time.Time { return now.Add(stateTTL) }
	if h.readState(v) != nil {
		t.Fatal("expired state accepted")
	}
}

// A whole backup against a fake Drive: the uploaded file opens with the recovery
// key, holds the hostel's rows, and each chunk matches the hash on the run row.
func TestBackupRoundTrip(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI(fixture.URI))
	if err != nil {
		t.Fatal(err)
	}
	db := client.Database("backup_round_trip_test")
	if err := db.Drop(ctx); err != nil {
		t.Skip("no Mongo: ", err)
	}
	defer db.Drop(context.Background())

	var stored []byte
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("refresh_token") != "refresh-1" {
			w.WriteHeader(400)
			io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		io.WriteString(w, `{"access_token":"access-1"}`)
	})
	var srv *httptest.Server
	mux.HandleFunc("/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer access-1" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Location", srv.URL+"/session")
	})
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		stored, _ = io.ReadAll(r.Body)
		sum := md5.Sum(stored)
		json.NewEncoder(w).Encode(map[string]string{"id": "file-1", "md5Checksum": hex.EncodeToString(sum[:]), "size": strconv.Itoa(len(stored))})
	})
	srv = httptest.NewServer(mux)
	defer srv.Close()
	drive := NewDrive("id", "secret")
	drive.TokenURL, drive.UploadURL, drive.FilesURL = srv.URL+"/token", srv.URL+"/upload", srv.URL+"/files"

	financeKey := "0000000000000000000000000000000000000000000000000000000000000002"
	h := &Handler{DB: db, Audit: audit.New(db), Drive: drive, FinanceKey: financeKey}
	main, branch, elsewhere := bson.NewObjectID(), bson.NewObjectID(), bson.NewObjectID()
	var secret [32]byte
	copy(secret[:], []byte("a recovery key of thirty-two b!!"))
	public := crypto.PublicKey(&secret)
	keys, _ := crypto.MasterKeys(financeKey, "")
	token, _ := crypto.EncryptSecret("refresh-1", crypto.Scope{HostelID: main.Hex(), Purpose: tokenPurpose}, keys[0])
	must := func(_ any, err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.Collection("hostels").InsertMany(ctx, []any{bson.D{{Key: "_id", Value: main}, {Key: "parentHostelId", Value: nil}}, bson.D{{Key: "_id", Value: branch}, {Key: "parentHostelId", Value: main}}}))
	must(db.Collection("notices").InsertMany(ctx, []any{
		bson.D{{Key: "hostelId", Value: main}, {Key: "title", Value: "Water <off> & on"}},
		bson.D{{Key: "hostelId", Value: branch}, {Key: "title", Value: "Branch"}},
		bson.D{{Key: "hostelId", Value: elsewhere}, {Key: "title", Value: "Not ours"}},
	}))
	must(db.Collection("users").InsertOne(ctx, bson.D{{Key: "name", Value: "Two jobs"}, {Key: "passwordHash", Value: "x"}, {Key: "hostelIds", Value: bson.A{main, elsewhere}}}))
	must(db.Collection("qractivations").InsertOne(ctx, bson.D{{Key: "hostelId", Value: main}, {Key: "codeHash", Value: "secret"}}))
	must(db.Collection("hostelbackups").InsertOne(ctx, bson.D{{Key: "hostelId", Value: main}, {Key: "drive", Value: bson.D{{Key: "status", Value: "CONNECTED"}, {Key: "token", Value: token}}}}))

	cfg := &backupRow{PublicKey: base64.StdEncoding.EncodeToString(public[:])}
	res, err := h.make(ctx, main, "MANUAL", "", cfg)
	if err != nil || !res.OK || !res.Checked {
		t.Fatalf("make: %+v %v", res, err)
	}
	header, plain, err := crypto.OpenArchive(stored, secret[:])
	if err != nil || header.HostelID != main.Hex() {
		t.Fatalf("open: %v %+v", err, header)
	}
	var archive struct {
		Counts    map[string]int `json:"counts"`
		HostelIDs []string       `json:"hostelIds"`
		Chunks    []archiveChunk `json:"chunks"`
	}
	if err := json.Unmarshal(plain, &archive); err != nil {
		t.Fatal(err)
	}
	counts := archive.Counts
	if counts["Notice"] != 2 || counts["User"] != 1 || counts["QRActivation"] != 1 || len(archive.HostelIDs) != 2 {
		t.Fatalf("counts %v ids %v", counts, archive.HostelIDs)
	}
	var run runRow
	oid, _ := bson.ObjectIDFromHex(res.ID)
	must(nil, db.Collection("hostelbackupruns").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}).Decode(&run))
	if run.DriveFileID != "file-1" || len(run.Chunks) != len(archive.Chunks) {
		t.Fatalf("run %+v", run)
	}
	for i, ch := range archive.Chunks {
		if run.Chunks[i].SHA256 != sha256Hex([]byte(ch.Data)) {
			t.Fatalf("chunk %s hash differs", ch.Collection)
		}
		rows, err := parseChunk(ch.Data)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			switch ch.Collection {
			case "User":
				if _, err := r.LookupErr("passwordHash"); err == nil {
					t.Fatal("a password hash left in the backup")
				}
				if ids, _ := r.Lookup("hostelIds").Array().Values(); len(ids) != 1 {
					t.Fatal("another hostel's id left on a user")
				}
			case "QRActivation":
				if _, err := r.LookupErr("codeHash"); err == nil {
					t.Fatal("a code hash left in the backup")
				}
			case "Notice":
				if id, _ := r.Lookup("hostelId").ObjectIDOK(); id == elsewhere {
					t.Fatal("another hostel's notice in the backup")
				}
			}
		}
	}
}
