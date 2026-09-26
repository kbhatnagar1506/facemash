// Command loadtest connects N bot players to the game server, walks them around at
// the client's 15 Hz send rate, and reports what each bot receives per second.
//
//	go run ./loadtest -n 1000 -spread 300 -secs 20
//
// -spread is the side of the square (metres) the bots wander in: small = everyone
// crowded together (worst case), large = spread over campus (typical).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	addr := flag.String("addr", "ws://localhost:8080/ws", "server websocket URL")
	n := flag.Int("n", 1000, "bots")
	spread := flag.Float64("spread", 300, "side of the wander square (m)")
	secs := flag.Int("secs", 20, "test length")
	room := flag.String("room", "campus", "campus or hackgt")
	flag.Parse()

	var msgs, bytes, conns, failed int64
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < *n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, _, err := websocket.DefaultDialer.Dial(*addr, map[string][]string{"Origin": {"http://localhost:8080"}})
			if err != nil {
				atomic.AddInt64(&failed, 1)
				return
			}
			defer c.Close()
			atomic.AddInt64(&conns, 1)
			x := 137 + (rand.Float64()-0.5)**spread
			z := -107 + (rand.Float64()-0.5)**spread
			c.WriteJSON(map[string]any{"t": "hello", "name": fmt.Sprintf("bot%d", i), "color": "#4f7fd6", "x": x, "z": z, "room": "campus", "look": "b=#ff8a3d;a=#ffffff;p=solid;e=dots;h=none;i=laptop"})
			if *room == "hackgt" {
				c.WriteJSON(map[string]any{"t": "room", "room": "hackgt", "x": (rand.Float64() - 0.5) * 30, "z": (rand.Float64() - 0.5) * 40})
			}
			go func() {
				for {
					_, b, err := c.ReadMessage()
					if err != nil {
						return
					}
					atomic.AddInt64(&msgs, 1)
					atomic.AddInt64(&bytes, int64(len(b)))
				}
			}()
			dir := rand.Float64() * math.Pi * 2
			t := time.NewTicker(time.Second / 15)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					dir += (rand.Float64() - 0.5) * 0.3
					x += math.Cos(dir) * 0.3 // ~4.5 m/s walk
					z += math.Sin(dir) * 0.3
					b, _ := json.Marshal(map[string]any{"t": "move", "x": x, "z": z, "r": dir, "m": true, "y": 0})
					if c.WriteMessage(websocket.TextMessage, b) != nil {
						return
					}
				}
			}
		}(i)
		if i%100 == 99 {
			time.Sleep(200 * time.Millisecond) // ramp up
		}
	}
	time.Sleep(3 * time.Second) // settle
	atomic.StoreInt64(&msgs, 0)
	atomic.StoreInt64(&bytes, 0)
	start := time.Now()
	time.Sleep(time.Duration(*secs) * time.Second)
	el := time.Since(start).Seconds()
	m, b, cn := atomic.LoadInt64(&msgs), atomic.LoadInt64(&bytes), atomic.LoadInt64(&conns)
	close(stop)
	log.Printf("bots connected %d (failed %d), room %s, spread %.0fm", cn, atomic.LoadInt64(&failed), *room, *spread)
	log.Printf("server → all bots: %.0f msgs/s, %.2f MB/s total", float64(m)/el, float64(b)/el/1e6)
	log.Printf("per bot: %.1f msgs/s, %.1f KB/s", float64(m)/el/float64(cn), float64(b)/el/float64(cn)/1e3)
	wg.Wait()
}
