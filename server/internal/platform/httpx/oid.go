package httpx

import (
	"errors"
	"net/http"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Code is an error's errorCode, "" when it is not an API error.
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.ErrorCode
	}
	return ""
}

// OID is normalizeObjectId (resident-access.ts): 422 "Invalid <label>." when
// value is not an object id.
func OID(value, label string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(value)
	if err != nil {
		return id, NewError(http.StatusUnprocessableEntity, "INVALID_OBJECT_ID", "Invalid "+label+".", nil)
	}
	return id, nil
}
