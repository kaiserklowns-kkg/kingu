package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"
)

// Cursor pagination (keyset). A list returns at most `limit` items and, when
// more exist, `next_cursor`: an opaque token the client passes back as
// `?cursor=` to get the next page. The cursor holds the sort key of the last
// item returned (a timestamp and/or an id), so pages stay stable while rows
// are added in front of them.

// cursor is the decoded sort key of the last item on a page. T is unused by
// lists ordered only by id.
type cursor struct {
	T  *time.Time `json:"t,omitempty"`
	ID string     `json:"id"`
}

// maxCursorLen bounds the ?cursor= value before decoding.
const maxCursorLen = 512

var errInvalidCursor = errBadRequest("invalid_cursor", "cursor is invalid; restart from the first page")

func encodeCursor(c cursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string, needTime bool) (*cursor, error) {
	if len(s) > maxCursorLen {
		return nil, errInvalidCursor
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, errInvalidCursor
	}
	var c cursor
	if err := json.Unmarshal(b, &c); err != nil || c.ID == "" || len(c.ID) > 255 || (needTime && c.T == nil) {
		return nil, errInvalidCursor
	}
	return &c, nil
}

// page is the parsed ?limit= and ?cursor= of a list request.
type page struct {
	Limit int
	After *cursor
}

// parsePage reads ?limit= (1..500, default 100) and ?cursor=. needTime says
// whether the list's sort key includes a timestamp. idIsUUID checks the id
// half so a tampered cursor fails as 400, not as a database error.
func parsePage(r *http.Request, needTime, idIsUUID bool) (page, error) {
	limit, err := parseLimit(r)
	if err != nil {
		return page{}, err
	}
	p := page{Limit: limit}
	if v := r.URL.Query().Get("cursor"); v != "" {
		c, err := decodeCursor(v, needTime)
		if err != nil {
			return page{}, err
		}
		if idIsUUID {
			id, ok := parseUUID(c.ID)
			if !ok {
				return page{}, errInvalidCursor
			}
			c.ID = id
		}
		p.After = c
	}
	return p, nil
}

// afterTime and afterID are the query arguments for the keyset predicate
// `($n::timestamptz IS NULL OR (sort_col, id) < ($n, $m))`.
func (p page) afterTime() *time.Time {
	if p.After == nil {
		return nil
	}
	return p.After.T
}

func (p page) afterID() *string {
	if p.After == nil {
		return nil
	}
	return &p.After.ID
}

// pageResponse is a list with an optional continuation cursor.
type pageResponse[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// pageOf trims items fetched with LIMIT limit+1 to limit and, when there was
// an extra row, sets next_cursor from the last kept item.
func pageOf[T any](items []T, limit int, key func(T) cursor) pageResponse[T] {
	if items == nil {
		items = []T{}
	}
	if len(items) <= limit {
		return pageResponse[T]{Items: items}
	}
	items = items[:limit]
	next := encodeCursor(key(items[len(items)-1]))
	return pageResponse[T]{Items: items, NextCursor: &next}
}
