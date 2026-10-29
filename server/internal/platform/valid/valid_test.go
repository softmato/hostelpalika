package valid

import (
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

func fail(err error) (int, string) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	httpx.Fail(c, err)
	return w.Code, w.Body.String()
}

type softmatoErr struct{}

func (softmatoErr) Error() string      { return "The request body failed validation" }
func (softmatoErr) SoftmatoRejection() {}

// Golden bodies are handleRouteError's output from zod 4.4.3 for
// z.object({ name: z.string().min(2), age: z.number().int(),
// profile: z.object({ phone: z.string().regex(/^\d+$/) }),
// tags: z.array(z.string()).max(1), kind: z.enum(["a","b"]) })
// given { name: "x", age: "1", profile: { phone: "ab" }, tags: ["a","b"], kind: "c" }.
func TestFail(t *testing.T) {
	var is Issues
	is.Add("name", TooSmall("string", 2, true))
	is.Add("age", Type("number", Received("1", false)))
	is.Add("profile.phone", Pattern(`/^\d+$/`))
	is.Add("tags", TooBig("array", 1, true))
	is.Add("kind", OneOf("a", "b"))
	var root Issues
	root.Add("", "root bad")
	var missing Issues
	missing.Add("a", Type("string", Received(nil, true)))

	dupKey, _ := bson.Marshal(bson.D{{Key: "code", Value: 11000}, {Key: "keyPattern", Value: bson.D{{Key: "phone", Value: 1}}}})
	dup := mongo.WriteException{WriteErrors: []mongo.WriteError{{Code: 11000, Message: "E11000", Raw: dupKey}}}

	for _, tc := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"zod fields", is.Err(), 422, `{"success":false,"message":"Validation failed","errorCode":"VALIDATION_ERROR","details":{"formErrors":[],"fieldErrors":{"name":["Too small: expected string to have >=2 characters"],"age":["Invalid input: expected number, received string"],"profile":["Invalid string: must match pattern /^\\d+$/"],"tags":["Too big: expected array to have <=1 items"],"kind":["Invalid option: expected one of \"a\"|\"b\""]},"issues":[{"message":"Too small: expected string to have >=2 characters","path":"name"},{"message":"Invalid input: expected number, received string","path":"age"},{"message":"Invalid string: must match pattern /^\\d+$/","path":"profile.phone"},{"message":"Too big: expected array to have <=1 items","path":"tags"},{"message":"Invalid option: expected one of \"a\"|\"b\"","path":"kind"}]}}`},
		{"zod root", root.Err(), 422, `{"success":false,"message":"Validation failed","errorCode":"VALIDATION_ERROR","details":{"formErrors":["root bad"],"fieldErrors":{},"issues":[{"message":"root bad","path":""}]}}`},
		{"zod missing", missing.Err(), 422, `{"success":false,"message":"Validation failed","errorCode":"VALIDATION_ERROR","details":{"formErrors":[],"fieldErrors":{"a":["Invalid input: expected string, received undefined"]},"issues":[{"message":"Invalid input: expected string, received undefined","path":"a"}]}}`},
		{"duplicate phone", dup, 409, `{"success":false,"message":"This phone number is already used by another account.","errorCode":"DUPLICATE_VALUE"}`},
		{"softmato", softmatoErr{}, 502, `{"success":false,"message":"Our payment server could not accept this: The request body failed validation","errorCode":"SOFTMATO_REJECTED"}`},
		{"unknown", errors.New("boom"), 500, `{"success":false,"message":"Internal server error","errorCode":"INTERNAL_SERVER_ERROR"}`},
	} {
		status, body := fail(tc.err)
		if status != tc.status || body != tc.body {
			t.Errorf("%s: %d %s\nwant %d %s", tc.name, status, body, tc.status, tc.body)
		}
	}
	if (Issues{}).Err() != nil {
		t.Error("empty Issues must be a nil error")
	}
}
