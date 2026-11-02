package fixture

import (
	"crypto/sha256"
	"encoding/hex"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

// Backup chunks the restore cases send back; the run rows record their hashes.
const (
	BackupNoticeChunk = `[{"_id":{"$oid":"6d04000000000000000000a0"},"hostelId":{"$oid":"6d0400000000000000000078"},"title":"Restored notice"}]`
	BackupHostelChunk = `[{"_id":{"$oid":"6d0400000000000000000078"}}]`
	BackupOtherChunk  = `[{"_id":{"$oid":"6d04000000000000000000a1"},"hostelId":{"$oid":"6d040000000000000000007d"},"title":"Not ours"}]`
	BackupPublicKey   = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
)

// Backup cases, all from gid(4, 120): 120 hostel + 121 owner on Pro with a key and
// runs, 127 a co-admin who is not the owner; 125 hostel + 126 owner with no plan.
func init() {
	extendGroup("admin-setup", func(now time.Time) map[string][]any {
		fixed := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		h, other := gid(4, 120), gid(4, 125)
		hostel := func(id, owner bson.ObjectID, slug string) bson.D {
			return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: "Backup " + slug}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: owner}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "status", Value: "ACTIVE"}, {Key: "verificationStatus", Value: "VERIFIED"}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
		}
		member := func(n int, hostelID, user bson.ObjectID) bson.D {
			return bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "hostelId", Value: hostelID}, {Key: "userId", Value: user}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}}
		}
		key := crypto.FromBase64(BackupPublicKey)
		fp := crypto.KeyFingerprint(key)
		sum := func(s string) string { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
		chunk := func(coll, data string) bson.D {
			return bson.D{{Key: "collection", Value: coll}, {Key: "index", Value: 0}, {Key: "rows", Value: 1}, {Key: "sha256", Value: sum(data)}}
		}
		run := func(n int, hostelID bson.ObjectID, status string, at time.Time, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: status}, {Key: "trigger", Value: "SCHEDULE"}, {Key: "keyFingerprint", Value: fp}, {Key: "checked", Value: false},
				{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
			return append(d, extra...)
		}
		chunks := bson.A{chunk("Notice", BackupNoticeChunk), chunk("Hostel", BackupHostelChunk), chunk("Expense", BackupOtherChunk)}
		return map[string][]any{
			"hostels": {hostel(h, gid(4, 121), "backup-pro"), hostel(other, gid(4, 126), "backup-free")},
			"users": {setupUser(gid(4, 121), "backup.owner@contract.test", "HOSTEL_ADMIN", bson.A{h}, now), setupUser(gid(4, 127), "backup.coadmin@contract.test", "HOSTEL_ADMIN", bson.A{h}, now),
				setupUser(gid(4, 126), "backup.free@contract.test", "HOSTEL_ADMIN", bson.A{other}, now)},
			"hostelmembers": {member(122, h, gid(4, 121)), member(128, h, gid(4, 127)), member(129, other, gid(4, 126))},
			"hostelsubscriptions": {bson.D{{Key: "_id", Value: gid(4, 123)}, {Key: "hostelId", Value: h}, {Key: "status", Value: "ACTIVE"}, {Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"},
				{Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1}, {Key: "source", Value: "PUBLIC"}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}},
			"hostelbackups": {
				bson.D{{Key: "_id", Value: gid(4, 124)}, {Key: "hostelId", Value: h}, {Key: "publicKey", Value: BackupPublicKey}, {Key: "keyFingerprint", Value: fp}, {Key: "keySetAt", Value: fixed},
					{Key: "keySetBy", Value: gid(4, 121)}, {Key: "drive", Value: bson.D{{Key: "connectedAt", Value: fixed}, {Key: "email", Value: "owner@gmail.test"}, {Key: "status", Value: "CONNECTED"}}},
					{Key: "lastRunAt", Value: fixed}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}},
				bson.D{{Key: "_id", Value: gid(4, 130)}, {Key: "hostelId", Value: other}, {Key: "publicKey", Value: BackupPublicKey}, {Key: "keyFingerprint", Value: fp}, {Key: "keySetAt", Value: fixed},
					{Key: "drive", Value: bson.D{{Key: "status", Value: "NOT_CONNECTED"}}}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}},
			},
			"hostelbackupruns": {
				run(131, h, "OK", fixed, bson.E{Key: "fileName", Value: "hostelpalika-backup-2026-09-01-06-00.hpbk"}, bson.E{Key: "bytes", Value: 2048}, bson.E{Key: "sha512", Value: "ab12"},
					bson.E{Key: "chunks", Value: chunks}, bson.E{Key: "driveFileId", Value: "drive-file-1"}, bson.E{Key: "counts", Value: bson.D{{Key: "Notice", Value: 1}, {Key: "Hostel", Value: 1}, {Key: "Expense", Value: 1}}}),
				run(132, h, "OK", fixed.Add(-24*time.Hour), bson.E{Key: "fileName", Value: "old.hpbk"}, bson.E{Key: "bytes", Value: 1024}, bson.E{Key: "chunks", Value: chunks}),
				run(133, h, "FAILED", fixed.Add(-48*time.Hour), bson.E{Key: "error", Value: "The backup could not be made."}, bson.E{Key: "chunks", Value: bson.A{}}),
				run(134, other, "OK", fixed, bson.E{Key: "driveFileId", Value: "drive-file-2"}, bson.E{Key: "chunks", Value: chunks}),
			},
		}
	})
}
