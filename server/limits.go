package main

// Per-person limits: a token bucket (how often) plus a cap on requests in flight at once (how
// many together), so one agent can't take a CPU, a worker or MAPI from everyone else. State
// lives in memory: a restart forgets it, which only ever errs on the side of letting people in.

import (
	"sync"
	"time"
)

type keyLimiter struct {
	burst    float64       // tokens a quiet person has saved up
	every    time.Duration // one token back per this long
	inFlight int           // at most this many at once per person (0: no cap)
	now      func() time.Time

	mu      sync.Mutex
	buckets map[fastWho]*bucket
	swept   time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
	busy   int
}

func newKeyLimiter(burst int, every time.Duration, inFlight int) *keyLimiter {
	return &keyLimiter{burst: float64(burst), every: every, inFlight: inFlight, now: time.Now, buckets: map[fastWho]*bucket{}}
}

// acquire takes a token and an in-flight slot; ok false means "not now" (wait says for how
// long, roughly). Call release when the request is done.
func (l *keyLimiter) acquire(who fastWho) (release func(), wait time.Duration, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.swept) > 10*time.Minute { // forget people who have gone quiet
		for k, b := range l.buckets {
			if b.busy == 0 && now.Sub(b.at) > time.Duration(l.burst)*l.every {
				delete(l.buckets, k)
			}
		}
		l.swept = now
	}
	b := l.buckets[who]
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[who] = b
	}
	b.tokens = min(l.burst, b.tokens+float64(now.Sub(b.at))/float64(l.every))
	b.at = now
	if l.inFlight > 0 && b.busy >= l.inFlight {
		return nil, time.Second, false
	}
	if b.tokens < 1 {
		return nil, time.Duration((1 - b.tokens) * float64(l.every)), false
	}
	b.tokens--
	b.busy++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			b.busy--
			l.mu.Unlock()
		})
	}, 0, true
}
