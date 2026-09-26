package main

// Keeping agents' token checks off the database. Every agent call names a token; looking it
// up used to be an UPDATE on api_tokens (last_used) per request, bad tokens included, over a
// small connection pool. Now a token must look like one of ours before it is looked up, a
// known token is remembered for tokenCacheTTL (which also means last_used is written at most
// once per TTL: TokenOwner records the use), and an address that keeps sending unknown
// tokens is made to wait (tokenMiss*). Revoking or replacing a token drops it from the cache.

import (
	"errors"
	"sync"
	"time"
)

const (
	tokenCacheTTL  = time.Minute
	tokenCacheMax  = 50_000
	tokenMissBurst = 20              // unknown tokens an address may try...
	tokenMissEvery = 3 * time.Second // ...and then one more per this long
	// /api/now: per address (every agent behind one proxy shares it, so it is generous) and per token
	nowIPBurst       = 300
	nowIPEvery       = 20 * time.Millisecond
	nowTokenBurst    = 20
	nowTokenEvery    = 500 * time.Millisecond
	nowTokenInFlight = 4
)

var errTokenMisses = errors.New("too many unknown tokens from this address")

// tokenWellFormed: tokenPrefix and 43 base64url characters (newToken's 32 random bytes).
func tokenWellFormed(tok string) bool {
	if len(tok) != len(tokenPrefix)+43 || tok[:len(tokenPrefix)] != tokenPrefix {
		return false
	}
	for i := len(tokenPrefix); i < len(tok); i++ {
		c := tok[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

type tokenEntry struct {
	tenant string
	id     int64
	exp    time.Time
}

type tokenCache struct {
	mu  sync.Mutex
	m   map[string]tokenEntry // sha256(token) → owner
	now func() time.Time
}

func newTokenCache() *tokenCache {
	return &tokenCache{m: map[string]tokenEntry{}, now: time.Now}
}

func (c *tokenCache) get(hash []byte) (tokenEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[string(hash)]
	if !ok || c.now().After(e.exp) {
		return tokenEntry{}, false
	}
	return e, true
}

func (c *tokenCache) put(hash []byte, tenant string, id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= tokenCacheMax { // everyone just looks their token up once more
		c.m = map[string]tokenEntry{}
	}
	c.m[string(hash)] = tokenEntry{tenant, id, c.now().Add(tokenCacheTTL)}
}

// dropOwner forgets every token of this person's (they revoked or replaced it).
func (c *tokenCache) dropOwner(tenant string, id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for h, e := range c.m {
		if e.tenant == tenant && e.id == id {
			delete(c.m, h)
		}
	}
}

// peek: would acquire succeed? (It takes nothing.)
func (l *keyLimiter) peek(who fastWho) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[who]
	if b == nil {
		return true
	}
	return min(l.burst, b.tokens+float64(l.now().Sub(b.at))/float64(l.every)) >= 1
}

// publicError is a tool error whose text is meant for the agent (a missing argument). Any
// other error (a database's, say) is logged and the agent gets publicMessage's generic text.
type publicError string

func (e publicError) Error() string { return string(e) }

func publicMessage(err error) string {
	var pe publicError
	if errors.As(err, &pe) {
		return string(pe)
	}
	return "temporarily unavailable, try again in a moment"
}
