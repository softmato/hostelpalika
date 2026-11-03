package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// The supply store (group 11): three departments, four products and two
// orders of HostelKyc, plus the platform staff who run it.
var (
	StoreBedding  = gid(11, 1)
	StoreCleaning = gid(11, 2)
	StoreOld      = gid(11, 3) // switched off
	StoreMattress = gid(11, 10)
	StoreSoap     = gid(11, 11) // no stock tracking, min 2
	StorePillow   = gid(11, 12) // 1 left, min 2
	StoreHidden   = gid(11, 13) // inactive
	StoreOrderNew = gid(11, 20) // PLACED
	StoreOrderOld = gid(11, 21) // DELIVERED
)

func init() {
	groupSeeds["store"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		at := fixedAt
		cat := func(id bson.ObjectID, name, slug, icon string, priority int, active bool) any {
			return d{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "icon", Value: icon}, {Key: "priority", Value: priority},
				{Key: "isActive", Value: active}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		prod := func(id, category bson.ObjectID, name, slug string, price, stock, min, max, priority int, track, featured, active bool, extra ...e) any {
			row := d{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "categoryId", Value: category}, {Key: "unit", Value: "piece"},
				{Key: "price", Value: price}, {Key: "images", Value: bson.A{}}, {Key: "tags", Value: bson.A{}}, {Key: "trackStock", Value: track}, {Key: "stockQuantity", Value: stock},
				{Key: "minOrderQuantity", Value: min}, {Key: "maxOrderQuantity", Value: max}, {Key: "isFeatured", Value: featured}, {Key: "priority", Value: priority},
				{Key: "isActive", Value: active}, {Key: "isDemoData", Value: false}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
			for _, x := range extra {
				for i := range row {
					if row[i].Key == x.Key {
						row[i].Value = x.Value
					}
				}
			}
			return row
		}
		order := func(id bson.ObjectID, number, status string, total int) any {
			return d{{Key: "_id", Value: id}, {Key: "orderNumber", Value: number}, {Key: "hostelId", Value: HostelKyc}, {Key: "placedBy", Value: UserAdmin},
				{Key: "items", Value: bson.A{d{{Key: "productId", Value: StoreMattress}, {Key: "name", Value: "Mattress"}, {Key: "unit", Value: "piece"}, {Key: "imageAssetId", Value: ""},
					{Key: "imageUrl", Value: "https://x.test/m.png"}, {Key: "unitPrice", Value: total}, {Key: "quantity", Value: 1}, {Key: "lineTotal", Value: total}, {Key: "stockAfterOrder", Value: 4}}}},
				{Key: "subtotal", Value: total}, {Key: "deliveryFee", Value: 0}, {Key: "total", Value: total}, {Key: "deliveryPromise", Value: "tomorrow morning before 7 AM"},
				{Key: "delivery", Value: d{{Key: "contactName", Value: "Contract Admin"}, {Key: "phone", Value: "9800000000"}, {Key: "addressLine", Value: "Lane 3"}, {Key: "city", Value: "Kathmandu"}}},
				{Key: "paymentMethod", Value: "COD"}, {Key: "paymentStatus", Value: "PENDING"}, {Key: "status", Value: status},
				{Key: "timeline", Value: bson.A{d{{Key: "status", Value: "PLACED"}, {Key: "at", Value: at}, {Key: "byUserId", Value: UserAdmin}, {Key: "note", Value: ""}}}},
				{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		return insertAll(ctx, db, map[string][]any{
			"users":           platformStaff(at),
			"storecategories": {cat(StoreBedding, "Bedding", "bedding", "bed", 5, true), cat(StoreCleaning, "Cleaning", "cleaning", "spray", 1, true), cat(StoreOld, "Old", "old", "cube", 0, false)},
			"storeproducts": {
				prod(StoreMattress, StoreBedding, "Mattress", "mattress", 450000, 5, 1, 3, 10, true, true, true,
					e{Key: "images", Value: bson.A{d{{Key: "url", Value: "https://x.test/m.png"}}}}, e{Key: "tags", Value: bson.A{"bed", "gaddi"}}),
				prod(StoreSoap, StoreCleaning, "Soap", "soap", 5000, 0, 2, 0, 0, false, false, true),
				prod(StorePillow, StoreBedding, "Pillow", "pillow", 80000, 1, 2, 0, 1, true, false, true),
				prod(StoreHidden, StoreBedding, "Hidden", "hidden", 100, 9, 1, 0, 0, true, false, false),
			},
			"storeorders": {order(StoreOrderNew, "SO-2610-0001-00A1", "PLACED", 450000), order(StoreOrderOld, "SO-2610-0002-00A1", "DELIVERED", 100000)},
		})
	}
}
