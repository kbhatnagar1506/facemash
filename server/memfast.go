package main

// Fast track: an attendee's own Muse can search what it sent us about them.
//
// When someone's agent sends their memory (POST /api/memory), agent_memory stays the source of
// truth and a small worker pool copies it into MAPI (the memory index) as keyed sections, in
// that person's own private space ("u-<id>": no name or email). Their agent can then ask:
//   - POST /api/ask/t/<key> {"q": "..."} (or /api/ask with the key as a bearer token; ?q= works too)
//   - the MCP tool ask_my_memory
//   - /api/now?q=... adds "memory" to the usual snapshot (without q, /api/now never calls MAPI)
// A search only ever covers the caller's own space, and returns ranked snippets: no model
// writes an answer here, since the agent asking is one. "Delete my memory" erases every copy
// in MAPI too, durably: a marker in mapi_purges keeps the erase going across restarts.
//
// Off unless MAPI_READ_URL / MAPI_WRITE_URL and a key for the tenant (MAPI_KEY_FILE_<tenant>, a
// file holding it, or MAPI_KEY_<tenant>) are set. Off, nothing here runs and every endpoint
// behaves exactly as before.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	askKeyPath       = "/api/ask/t/" // + token: questions about the person themself
	fastAskTimeout   = 1200 * time.Millisecond
	fastAskLimit     = 8
	fastSnippetRunes = 1500
	fastMaxQuery     = 1000 // runes
	fastBatch        = 50   // items per bulk write
	fastWorkers      = 2
	fastSyncTries    = 6
)

// ---------- the MAPI client ----------

// fastClient talks to MAPI: reads (search, listing) go to MAPI_READ_URL and never retry,
// since they have a person waiting; writes go to MAPI_WRITE_URL and retry 429s, 5xx and
// network errors with backoff, honouring Retry-After.
type fastClient struct {
	read, write string
	key         func(tenant string) string
	hc          *http.Client
	tries       int           // attempts for a write
	backoff     time.Duration // first retry wait (doubles each time)
	maxWait     time.Duration // cap on any one wait, Retry-After included
}

func newFastClient(read, write string, key func(string) string) *fastClient {
	tr := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second, // MAPI keeps connections 120 s, so it never closes one we're about to reuse
	}
	return &fastClient{read: read, write: write, key: key, hc: &http.Client{Transport: tr}, tries: 5, backoff: 500 * time.Millisecond, maxWait: 30 * time.Second}
}

// fastProblem is a MAPI error (RFC 9457 problem+json). Error() never includes the detail,
// which can quote what was sent.
type fastProblem struct {
	Status     int     `json:"status"`
	Code       string  `json:"code"`
	Detail     string  `json:"detail"`
	RetryAfter float64 `json:"retry_after"`
	wait       time.Duration
}

func (p *fastProblem) Error() string { return fmt.Sprintf("mapi %d %s", p.Status, p.Code) }

func fastStatus(err error) int {
	var p *fastProblem
	if errors.As(err, &p) {
		return p.Status
	}
	return 0
}

func (c *fastClient) do(ctx context.Context, tenant, method, path string, in, out any, write bool) error {
	key := c.key(tenant)
	if key == "" {
		return errors.New("no MAPI key for this tenant")
	}
	base := c.read
	if write {
		base = c.write
	}
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	tries := 1
	if write {
		tries = c.tries
	}
	var last error
	for i := 0; i < tries; i++ {
		if i > 0 {
			wait := c.backoff << (i - 1)
			wait += time.Duration(rand.Int64N(int64(wait)/5 + 1)) // jitter, so retries don't march in step
			var p *fastProblem
			if errors.As(last, &p) && p.wait > 0 {
				wait = p.wait
			}
			wait = min(wait, c.maxWait)
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return last
			case <-t.C:
			}
		}
		last = c.once(ctx, key, method, base+path, body, out)
		if last == nil || !fastRetryable(ctx, last) {
			return last
		}
		log.Printf("memfast: %s %s: %v (try %d of %d)", method, fastOp(path), last, i+1, tries)
	}
	return last
}

func fastRetryable(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	if s := fastStatus(err); s != 0 {
		return s == http.StatusTooManyRequests || s >= 500
	}
	return true // the network
}

func (c *fastClient) once(ctx context.Context, key, method, u string, body []byte, out any) error {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if res.StatusCode/100 != 2 {
		p := &fastProblem{}
		json.Unmarshal(b, p)
		p.Status = res.StatusCode
		if s := res.Header.Get("Retry-After"); s != "" {
			if n, err := strconv.ParseFloat(s, 64); err == nil && n >= 0 {
				p.wait = time.Duration(n * float64(time.Second))
			} else if t, err := http.ParseTime(s); err == nil {
				p.wait = time.Until(t)
			}
		} else if p.RetryAfter > 0 {
			p.wait = time.Duration(p.RetryAfter * float64(time.Second))
		}
		return p
	}
	if err != nil {
		return err
	}
	if out != nil && len(b) > 0 {
		return json.Unmarshal(b, out)
	}
	return nil
}

// fastOp names a call for the log without ids: /v1/spaces/spc_x/memories/bulk → spaces/*/memories/bulk.
func fastOp(path string) string {
	path, _, _ = strings.Cut(path, "?")
	parts := strings.Split(strings.TrimPrefix(path, "/v1/"), "/")
	for i, p := range parts {
		if strings.HasPrefix(p, "spc_") || strings.HasPrefix(p, "mem_") {
			parts[i] = "*"
		}
	}
	return strings.Join(parts, "/")
}

type fastMemory struct {
	ID       string         `json:"id"`
	SpaceID  string         `json:"space_id"`
	Content  string         `json:"content"`
	Metadata map[string]any `json:"metadata"`
}

type fastHit struct {
	Memory      fastMemory `json:"memory"`
	Score       float64    `json:"score"`
	MatchedText string     `json:"matched_text"`
}

type fastWrite struct {
	Content    string         `json:"content"`
	Metadata   map[string]any `json:"metadata"`
	Tags       []string       `json:"tags"`
	Source     string         `json:"source"`
	OccurredAt *time.Time     `json:"occurred_at,omitempty"`
}

func fastSpacePath(sid, rest string) string { return "/v1/spaces/" + url.PathEscape(sid) + rest }

// ---------- the service ----------

type fastWho struct {
	tenant string
	id     int64
}

// fastJob is what's waiting for one person. Uploads coalesce (only the latest is written);
// a purge always runs before any sync queued with it.
type fastJob struct {
	purge bool
	sync  bool
	items []fastItem
	gen   uint64 // which upload (or delete) this sync belongs to
	tries int
}

type memFast struct {
	store      fastStore
	mapi       *fastClient
	askTimeout time.Duration
	retryBase  time.Duration // first wait before retrying a failed sync or purge
	retryMax   time.Duration
	sweepEvery time.Duration // how often open purge markers are picked up (and once at start)

	mu      sync.Mutex
	cond    *sync.Cond
	queue   []fastWho // each person at most once, and never while running
	pending map[fastWho]*fastJob
	running map[fastWho]bool
	gen     map[fastWho]uint64
	closed  bool
	wg      sync.WaitGroup
	stop    chan struct{}
}

func newMemFast(store fastStore, mapi *fastClient) *memFast {
	f := &memFast{
		store: store, mapi: mapi, askTimeout: fastAskTimeout,
		retryBase: 5 * time.Second, retryMax: 5 * time.Minute, sweepEvery: time.Minute,
		pending: map[fastWho]*fastJob{}, running: map[fastWho]bool{}, gen: map[fastWho]uint64{},
		stop: make(chan struct{}),
	}
	f.cond = sync.NewCond(&f.mu)
	return f
}

// openMemFast turns the feature on from the environment; nil (off) when MAPI isn't configured.
func openMemFast(acc *accounts) *memFast {
	read := strings.TrimRight(os.Getenv("MAPI_READ_URL"), "/")
	write := strings.TrimRight(os.Getenv("MAPI_WRITE_URL"), "/")
	if read == "" && write == "" {
		return nil
	}
	if read == "" {
		read = write
	}
	if write == "" {
		write = read
	}
	if acc == nil {
		return nil
	}
	fs, ok := acc.store.(fastStore)
	if !ok {
		log.Printf("memfast: off: the account store can't keep the index's bookkeeping")
		return nil
	}
	keys := fastKeysFromEnv()
	if keys(acc.tenant) == "" {
		log.Printf("memfast: off: no MAPI key for tenant %s (set MAPI_KEY_FILE_%s or MAPI_KEY_%s)", acc.tenant, fastEnvName(acc.tenant), fastEnvName(acc.tenant))
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := fs.fastEnsureSchema(ctx); err != nil {
		log.Printf("memfast: off: schema: %v", err)
		return nil
	}
	f := newMemFast(fs, newFastClient(read, write, keys))
	f.start(fastWorkers)
	log.Printf("memfast: on, tenant %s (read %s, write %s)", acc.tenant, read, write)
	return f
}

func fastEnvName(tenant string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '_'
	}, tenant)
}

// fastKeysFromEnv: each tenant's MAPI key, read once. Keys come from a file (preferred) or the
// environment, and are never logged.
func fastKeysFromEnv() func(string) string {
	var mu sync.Mutex
	cache := map[string]string{}
	return func(tenant string) string {
		mu.Lock()
		defer mu.Unlock()
		if k, ok := cache[tenant]; ok {
			return k
		}
		k := ""
		name := fastEnvName(tenant)
		for _, v := range []string{"MAPI_KEY_FILE_" + name, "MAPI_KEY_FILE_" + strings.ToUpper(name)} {
			if p := os.Getenv(v); p != "" && k == "" {
				b, err := os.ReadFile(p)
				if err != nil {
					log.Printf("memfast: %s: can't read the key file", v)
					continue
				}
				k = strings.TrimSpace(string(b))
			}
		}
		for _, v := range []string{"MAPI_KEY_" + name, "MAPI_KEY_" + strings.ToUpper(name)} {
			if k == "" {
				k = strings.TrimSpace(os.Getenv(v))
			}
		}
		cache[tenant] = k
		return k
	}
}

func (f *memFast) start(workers int) {
	for i := 0; i < workers; i++ {
		f.wg.Add(1)
		go f.worker()
	}
	f.wg.Add(1)
	go f.sweep()
}

// close stops the workers after the jobs they're on (tests; the server runs until it exits).
func (f *memFast) close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	close(f.stop)
	f.cond.Broadcast()
	f.mu.Unlock()
	f.wg.Wait()
}

func (f *memFast) enqueue(who fastWho, mutate func(*fastJob)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	j := f.pending[who]
	if j == nil {
		j = &fastJob{}
		f.pending[who] = j
		if !f.running[who] {
			f.queue = append(f.queue, who)
			f.cond.Signal()
		}
	}
	mutate(j)
}

func (f *memFast) worker() {
	defer f.wg.Done()
	for {
		f.mu.Lock()
		for len(f.queue) == 0 && !f.closed {
			f.cond.Wait()
		}
		if f.closed {
			f.mu.Unlock()
			return
		}
		who := f.queue[0]
		f.queue = f.queue[1:]
		job := f.pending[who]
		delete(f.pending, who)
		f.running[who] = true
		f.mu.Unlock()

		if job != nil {
			f.run(who, job)
		}

		f.mu.Lock()
		delete(f.running, who)
		if f.pending[who] != nil && !f.closed { // more came in while this ran
			f.queue = append(f.queue, who)
			f.cond.Signal()
		}
		f.mu.Unlock()
	}
}

// sweep picks up open purge markers: at start (a restart mid-erase) and then every so often
// (a marker whose retry was lost).
func (f *memFast) sweep() {
	defer f.wg.Done()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		whos, err := f.store.fastPendingPurges(ctx)
		cancel()
		if err != nil {
			log.Printf("memfast: pending purges: %v", err)
		}
		for _, who := range whos {
			if f.mapi.key(who.tenant) == "" {
				continue
			}
			f.enqueue(who, func(j *fastJob) { j.purge = true })
		}
		t := time.NewTimer(f.sweepEvery)
		select {
		case <-f.stop:
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// later retries a failed job after a backoff, unless something newer has replaced it.
func (f *memFast) later(who fastWho, job *fastJob) {
	d := f.retryBase << min(job.tries, 16)
	if d > f.retryMax || d <= 0 {
		d = f.retryMax
	}
	job.tries++
	time.AfterFunc(d, func() {
		f.enqueue(who, func(j *fastJob) {
			if job.purge {
				j.purge = true
				j.tries = max(j.tries, job.tries)
			}
			if job.sync && !j.sync && job.gen == f.gen[who] {
				j.sync, j.items, j.gen, j.tries = true, job.items, job.gen, max(j.tries, job.tries)
			}
		})
	})
}

func (f *memFast) run(who fastWho, job *fastJob) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("memfast: #%d: panic: %v", who.id, r)
		}
	}()
	// an open delete always goes first, whether or not this job was queued for it
	if err := f.purgeNow(who); err != nil {
		log.Printf("memfast: #%d purge failed, will retry: %v", who.id, err)
		job.purge = true
		f.later(who, job)
		return
	}
	if !job.sync {
		return
	}
	if err := f.syncNow(who, job.items); err != nil {
		if job.tries+1 >= fastSyncTries {
			log.Printf("memfast: #%d sync failed %d times, giving up until the next upload: %v", who.id, job.tries+1, err)
			return
		}
		log.Printf("memfast: #%d sync failed, will retry: %v", who.id, err)
		f.later(who, &fastJob{sync: true, items: job.items, gen: job.gen, tries: job.tries})
	}
}

// uploaded queues a sync of what someone's agent just sent (called after agent_memory has it).
func (f *memFast) uploaded(tenant string, id int64, obj map[string]any) {
	if f == nil || id == 0 {
		return
	}
	items, cut := fastSplit(obj)
	who := fastWho{tenant, id}
	f.enqueue(who, func(j *fastJob) {
		f.gen[who]++
		j.sync, j.items, j.gen, j.tries = true, items, f.gen[who], 0
	})
	log.Printf("memfast: #%d upload queued: %d sections, %d cut by the caps", id, len(items), cut)
}

// forget records that everything of this person's in MAPI must go, then erases it in the
// background. When this returns nil, the erase will happen, restarts included.
func (f *memFast) forget(ctx context.Context, tenant string, id int64) error {
	if f == nil {
		return nil
	}
	if err := f.store.fastRequestPurge(ctx, tenant, id); err != nil {
		return err
	}
	who := fastWho{tenant, id}
	f.enqueue(who, func(j *fastJob) {
		f.gen[who]++ // an older upload still waiting (or retrying) must not come back
		j.purge, j.sync, j.items = true, false, nil
	})
	log.Printf("memfast: #%d purge queued", id)
	return nil
}

// busy: is an upload of this person's still being indexed?
func (f *memFast) busy(who fastWho) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.running[who] || (f.pending[who] != nil && f.pending[who].sync)
}

func (f *memFast) ensureSpace(ctx context.Context, who fastWho) (string, error) {
	sid, _, err := f.store.fastSpace(ctx, who.tenant, who.id)
	if err != nil || sid != "" {
		return sid, err
	}
	slug := fmt.Sprintf("u-%d", who.id)
	var sp struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
	}
	err = f.mapi.do(ctx, who.tenant, http.MethodPost, "/v1/spaces", map[string]any{"slug": slug, "name": slug}, &sp, true)
	if fastStatus(err) == http.StatusConflict {
		// made before, but we lost the id (or a retried create landed twice): find it by slug.
		// GET /v1/spaces counts every space's memories, so this is only ever a recovery path.
		var list struct {
			Items []struct {
				ID   string `json:"id"`
				Slug string `json:"slug"`
			} `json:"items"`
		}
		if err = f.mapi.do(ctx, who.tenant, http.MethodGet, "/v1/spaces", nil, &list, false); err == nil {
			err = fmt.Errorf("space %s exists but isn't listed", slug)
			for _, s := range list.Items {
				if s.Slug == slug {
					sp.ID, sp.Slug, err = s.ID, s.Slug, nil
				}
			}
		}
	}
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(sp.ID, "spc_") {
		return "", fmt.Errorf("MAPI returned a bad space id")
	}
	return sp.ID, f.store.fastSetSpace(ctx, who.tenant, who.id, sp.ID)
}

// erase is MAPI's right-to-erasure delete (row, chunks, edges and version history). A 404
// means it's already gone, which is what we wanted.
func (f *memFast) erase(ctx context.Context, tenant, sid, mid string) error {
	err := f.mapi.do(ctx, tenant, http.MethodPost, fastSpacePath(sid, "/memories/"+url.PathEscape(mid)+"/erase"), nil, nil, true)
	if fastStatus(err) == http.StatusNotFound {
		return nil
	}
	return err
}

// syncNow makes the person's space match items: unchanged sections cost nothing, a changed
// one is erased and written again (never left to MAPI's near-duplicate merge, which can keep
// the old text), and a section that's gone is erased.
func (f *memFast) syncNow(who fastWho, items []fastItem) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	start := time.Now()
	rows, err := f.store.fastItems(ctx, who.tenant, who.id)
	if err != nil {
		return err
	}
	want := map[string]*fastItem{}
	for i := range items {
		want[items[i].Key] = &items[i]
	}
	inUse := map[string]bool{} // memory ids that unchanged sections still point at
	var stale []string
	for k, r := range rows {
		if it := want[k]; it != nil && bytes.Equal(it.SHA, r.SHA) {
			inUse[r.MemID] = true
		} else {
			stale = append(stale, k)
		}
	}
	sort.Strings(stale)
	var fresh []*fastItem
	for i := range items {
		if r, ok := rows[items[i].Key]; !ok || !bytes.Equal(r.SHA, items[i].SHA) {
			fresh = append(fresh, &items[i])
		}
	}
	if len(stale) == 0 && len(fresh) == 0 {
		log.Printf("memfast: #%d sync: %d sections, all unchanged (%.1fms)", who.id, len(items), ms(time.Since(start)))
		return nil
	}
	sid, err := f.ensureSpace(ctx, who)
	if err != nil {
		return err
	}
	erased := 0
	for _, k := range stale {
		mid := rows[k].MemID
		if mid == "" || inUse[mid] {
			continue
		}
		if err := f.erase(ctx, who.tenant, sid, mid); err != nil {
			return err
		}
		inUse[mid] = true // erased once is enough
		erased++
	}
	if err := f.store.fastDropItems(ctx, who.tenant, who.id, stale); err != nil {
		return err
	}
	for i := 0; i < len(fresh); i += fastBatch {
		batch := fresh[i:min(i+fastBatch, len(fresh))]
		req := struct {
			Items []fastWrite `json:"items"`
		}{}
		for _, it := range batch {
			req.Items = append(req.Items, fastWrite{
				Content:    it.Content,
				Metadata:   map[string]any{"key": it.Key, "section": it.Section},
				Tags:       []string{it.Section},
				Source:     "muse:" + it.Key,
				OccurredAt: it.Occurred,
			})
		}
		var res struct {
			Items []struct {
				Memory fastMemory `json:"memory"`
			} `json:"items"`
		}
		wctx, wcancel := context.WithTimeout(ctx, 3*time.Minute)
		err := f.mapi.do(wctx, who.tenant, http.MethodPost, fastSpacePath(sid, "/memories/bulk"), req, &res, true)
		wcancel()
		if fastStatus(err) == http.StatusNotFound {
			// the space is gone on MAPI's side: start this person over with a new one
			f.store.fastClear(ctx, who.tenant, who.id, nil)
			return fmt.Errorf("space gone: %w", err)
		}
		if err != nil {
			return err
		}
		if len(res.Items) != len(batch) {
			return fmt.Errorf("bulk write answered %d of %d", len(res.Items), len(batch))
		}
		put := make([]fastRow, len(batch))
		for j, it := range batch {
			put[j] = fastRow{Key: it.Key, SHA: it.SHA, MemID: res.Items[j].Memory.ID}
		}
		if err := f.store.fastPutItems(ctx, who.tenant, who.id, put); err != nil {
			return err
		}
	}
	log.Printf("memfast: #%d sync: %d sections, %d unchanged, %d erased, %d written in %.1fms",
		who.id, len(items), len(items)-len(fresh), erased, len(fresh), ms(time.Since(start)))
	return nil
}

// purgeNow carries out any open delete for this person: every memory we wrote, and anything
// else still in their space, is erased (MAPI's DELETE of a space keeps version history, so
// that alone isn't enough), then the space is deleted.
func (f *memFast) purgeNow(who fastWho) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	marks, spaces, err := f.store.fastPurges(ctx, who.tenant, who.id)
	if err != nil || len(marks) == 0 {
		return err
	}
	start := time.Now()
	fail := func(err error) error {
		f.store.fastPurgeFailed(ctx, marks, err.Error())
		return err
	}
	rows, err := f.store.fastItems(ctx, who.tenant, who.id)
	if err != nil {
		return fail(err)
	}
	erased := 0
	for _, sid := range spaces {
		ids := map[string]bool{}
		for _, r := range rows {
			if r.MemID != "" {
				ids[r.MemID] = true
			}
		}
		listed, err := f.listIDs(ctx, who.tenant, sid)
		if fastStatus(err) == http.StatusNotFound {
			continue // the space is already gone
		}
		if err != nil {
			return fail(err)
		}
		for _, id := range listed {
			ids[id] = true
		}
		sorted := make([]string, 0, len(ids))
		for id := range ids {
			sorted = append(sorted, id)
		}
		sort.Strings(sorted)
		for _, id := range sorted {
			if err := f.erase(ctx, who.tenant, sid, id); err != nil {
				return fail(err)
			}
			erased++
		}
		if err := f.mapi.do(ctx, who.tenant, http.MethodDelete, fastSpacePath(sid, ""), nil, nil, true); err != nil && fastStatus(err) != http.StatusNotFound {
			return fail(err)
		}
	}
	if err := f.store.fastClear(ctx, who.tenant, who.id, marks); err != nil {
		return err
	}
	log.Printf("memfast: #%d purged: %d memories erased, %d spaces deleted in %.1fms", who.id, erased, len(spaces), ms(time.Since(start)))
	return nil
}

// listIDs: every memory in a space, whatever its status.
func (f *memFast) listIDs(ctx context.Context, tenant, sid string) ([]string, error) {
	var out []string
	cursor := ""
	for page := 0; page < 100; page++ {
		q := url.Values{"limit": {"100"}, "status": {"active", "superseded", "archived", "stale"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var res struct {
			Items      []fastMemory `json:"items"`
			NextCursor string       `json:"next_cursor"`
		}
		if err := f.mapi.do(ctx, tenant, http.MethodGet, fastSpacePath(sid, "/memories?"+q.Encode()), nil, &res, false); err != nil {
			return nil, err
		}
		for _, m := range res.Items {
			if m.SpaceID == sid && m.ID != "" {
				out = append(out, m.ID)
			}
		}
		if res.NextCursor == "" || res.NextCursor == cursor {
			break
		}
		cursor = res.NextCursor
	}
	return out, nil
}

// ---------- asking ----------

const fastNote = "These are snippets of this person's own notes (what their agent sent to HackGT 13), best match first, with where each came from. " +
	"Answer their question from them; they're private to this person, so don't share them with anyone else."

// ask searches the person's own space, and always answers within askTimeout: after that it
// says "busy" rather than keep an agent (and its person) waiting.
func (f *memFast) ask(ctx context.Context, tenant string, id int64, q string) map[string]any {
	ctx, cancel := context.WithTimeout(ctx, f.askTimeout)
	defer cancel()
	ch := make(chan map[string]any, 1)
	go func() { ch <- f.askNow(ctx, tenant, id, q) }()
	select {
	case out := <-ch:
		return out
	case <-ctx.Done():
		return fastBusy()
	}
}

func fastBusy() map[string]any {
	return map[string]any{"status": "busy", "note": "Memory search is busy right now; try again in a moment."}
}

func (f *memFast) askNow(ctx context.Context, tenant string, id int64, q string) map[string]any {
	start := time.Now()
	sid, purging, err := f.store.fastSpace(ctx, tenant, id)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("memfast: #%d ask: space: %v", id, err)
		}
		return fastBusy()
	}
	if sid == "" || purging {
		if !purging && f.busy(fastWho{tenant, id}) {
			return map[string]any{"status": "indexing", "note": "Their memory just arrived and is still being indexed; try again in a minute."}
		}
		return map[string]any{"status": "no_memory", "note": "This person's agent hasn't sent their memory to HackGT 13 (or they deleted it), so there's nothing to search. They can send it from the HackGT 13 app: Connect your Muse."}
	}
	var res struct {
		Results []fastHit `json:"results"`
	}
	// include_superseded skips MAPI's per-hit supersession walk (about 0.3 s instead of 0.7 s at
	// p50): these spaces never hold superseded rows, since a changed section is erased and rewritten.
	body := map[string]any{"query": q, "limit": fastAskLimit, "coverage": false, "include_superseded": true}
	if err := f.mapi.do(ctx, tenant, http.MethodPost, fastSpacePath(sid, "/search"), body, &res, false); err != nil {
		if ctx.Err() == nil {
			log.Printf("memfast: #%d ask: %v (%.1fms)", id, err, ms(time.Since(start)))
		}
		return fastBusy()
	}
	results := []map[string]any{}
	dropped := 0
	for _, h := range res.Results {
		if h.Memory.SpaceID != sid { // only ever this person's own space
			dropped++
			continue
		}
		title, text, _ := strings.Cut(h.Memory.Content, "\n")
		if h.MatchedText != "" && !strings.Contains(h.MatchedText, title) {
			text = h.MatchedText
		}
		text = strings.TrimSpace(text)
		if r := []rune(text); len(r) > fastSnippetRunes {
			text = string(r[:fastSnippetRunes]) + "…"
		}
		section, _ := h.Memory.Metadata["section"].(string)
		key, _ := h.Memory.Metadata["key"].(string)
		results = append(results, map[string]any{
			"from": title, "section": section, "key": strings.TrimPrefix(key, "muse:"),
			"score": float64(int(h.Score*10000)) / 10000, "text": text,
		})
		if len(results) == fastAskLimit {
			break
		}
	}
	if dropped > 0 {
		log.Printf("memfast: #%d ask: dropped %d hits from another space", id, dropped)
	}
	if len(results) == 0 {
		return map[string]any{"status": "no_match", "results": results, "count": 0, "note": "Nothing in this person's notes matches that."}
	}
	return map[string]any{"status": "ok", "results": results, "count": len(results), "note": fastNote}
}

// fastQuery reads the question: POST {"q": "..."} (preferred), or ?q=.
func fastQuery(r *http.Request) string {
	q := r.URL.Query().Get("q")
	if r.Method == http.MethodPost {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 16*1024))
		var in struct {
			Q        string `json:"q"`
			Query    string `json:"query"`
			Question string `json:"question"`
		}
		if json.Unmarshal(b, &in) == nil {
			if s := firstNonEmpty(in.Q, in.Query, in.Question); s != "" {
				q = s
			}
		}
	}
	q = strings.TrimSpace(strings.ToValidUTF8(q, ""))
	if utf8.RuneCountInString(q) > fastMaxQuery {
		q = string([]rune(q)[:fastMaxQuery])
	}
	return q
}

// askHandler serves /api/ask and /api/ask/t/<key>.
func (f *memFast) askHandler(caller func(*http.Request) (*museCaller, error), unauthorized func(http.ResponseWriter), writeJSON func(http.ResponseWriter, int, any)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			w.Header().Set("Allow", "POST, GET")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": `POST {"q": "your question"}`})
			return
		}
		c, err := caller(r)
		if err != nil {
			unauthorized(w)
			return
		}
		start := time.Now()
		defer func() { calls.add(c.id, r.Method+" /api/ask", start, time.Since(start)) }() // never the question
		q := fastQuery(r)
		if q == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": `send {"q": "your question"}`})
			return
		}
		writeJSON(w, http.StatusOK, f.ask(r.Context(), c.tenant, c.id, q))
	}
}

// nowMemory starts the memory half of /api/now?q=...: nil without a question (then /api/now
// makes no MAPI call at all) or with the feature off.
func (f *memFast) nowMemory(r *http.Request, c *museCaller) <-chan map[string]any {
	if f == nil || r.Method == http.MethodHead {
		return nil
	}
	q := fastQuery(r)
	if q == "" {
		return nil
	}
	ch := make(chan map[string]any, 1)
	go func() { ch <- f.ask(r.Context(), c.tenant, c.id, q) }()
	return ch
}

// ---------- the agent's side: tool and prompts ----------

var fastTools = []tool{
	{
		Name:        "ask_my_memory",
		Title:       "Search my own notes",
		Description: "For questions about the person you're helping (what do you know about me, what was I working on, what did I decide about X): searches the notes their own agent sent to HackGT 13 (MEMORY.md, USER.md, daily notes, memory bank) and returns the best-matching snippets. Only ever their own notes.",
		Input: map[string]any{
			"type":                 "object",
			"properties":           map[string]any{"q": map[string]any{"type": "string", "description": "the question, in plain words"}},
			"required":             []string{"q"},
			"additionalProperties": false,
		},
		Path: "ask",
		Run: func(ctx context.Context, c *museCaller, args map[string]any) (any, error) {
			q, _ := args["q"].(string)
			q = strings.TrimSpace(q)
			if q == "" {
				return nil, errors.New("q is required")
			}
			if utf8.RuneCountInString(q) > fastMaxQuery {
				q = string([]rune(q)[:fastMaxQuery])
			}
			return c.acc.fast.ask(ctx, c.tenant, c.id, q), nil
		},
	},
}

// tools: what this caller's agent can use (ask_my_memory only while the feature is on).
func (c *museCaller) tools() []tool {
	if c.acc == nil || c.acc.fast == nil {
		return museTools
	}
	return append(museTools[:len(museTools):len(museTools)], fastTools...)
}

// prompts adds the memory fast path to what a newly paired agent is told.
func (f *memFast) prompts(info map[string]any, base, tok string) {
	if f == nil {
		return
	}
	ask := base + askKeyPath + tok
	info["ask_url"] = ask
	info["prompt"] = fastConnectorPrompt(base, tok)
	if mp, ok := info["memory_prompt"].(string); ok {
		info["memory_prompt"] = mp + "\nLater, for questions about me (\"what do you know about me\", \"what was I working on\"), make ONE HTTP POST to " + ask +
			" with the JSON body {\"q\": \"<my question>\"} and answer from the snippets it returns. Keep that link secret too."
	}
}

func fastConnectorPrompt(base, tok string) string {
	return "Save this as my HackGT 13 skill. These links contain my private key: keep them secret and never show them in chat.\n" +
		"FAST PATH for HackGT questions: make ONE HTTP GET to " + base + nowKeyPath + tok +
		" and answer from the JSON it returns (what's on now and next, how many people are here, and my profile).\n" +
		"QUESTIONS ABOUT ME (\"what do you know about me\", \"what was I working on\", \"what did I say about X\"): make ONE HTTP POST to " + base + askKeyPath + tok +
		" with the JSON body {\"q\": \"<my question>\"} and answer from the snippets of my own notes it returns.\n" +
		"Don't list tools, don't do an MCP handshake, don't make other calls first.\n" +
		"Only if those don't cover the question: the MCP server at " + base + mcpKeyPath + tok + " has the full schedule (get_schedule with when=all) and ask_my_memory.\n" +
		"Now tell me what's happening at HackGT right now."
}
