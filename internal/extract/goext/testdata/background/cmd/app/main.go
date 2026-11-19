// Command app starts the server and its background work.
package main

import (
	"net"
	"net/http"
	"time"

	"background/fetch"
	"background/notify"
	"background/rules"
	"background/server"
)

type job struct{ feed fetch.Feed }

func main() {
	queue := make(chan job)
	for i := 0; i < 4; i++ {
		go worker(queue) // a pool started at startup: one job
	}
	go cleanupScheduler(time.Hour)
	go func() {
		for {
			refreshAll(queue)
			time.Sleep(5 * time.Minute)
		}
	}()
	go poll()
	time.AfterFunc(10*time.Second, warmCache)
	go sendStartup() // runs once: a call, not a job
	every(time.Minute, flush)
	go accept()
	_ = rules.Run("a")
	_ = http.ListenAndServe(":8080", server.Routes())
}

func worker(queue <-chan job) {
	for j := range queue {
		_ = fetch.Refresh(j.feed)
	}
}

func cleanupScheduler(d time.Duration) {
	for range time.Tick(d) {
		cleanup()
	}
}

func cleanup() {}

func refreshAll(queue chan<- job) { queue <- job{} }

func poll() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	done := make(chan struct{})
	for {
		select {
		case <-done:
			return
		case <-t.C:
			check()
		}
	}
}

func check() { _ = notify.Chat(notify.Settings{}) }

func warmCache() { _ = fetch.Version() }

func sendStartup() { _ = notify.Notify("", "started") }

// every is a scheduling helper: what it runs is its caller's, so its own
// goroutine is not a job.
func every(d time.Duration, fn func()) {
	go func() {
		for {
			time.Sleep(d)
			fn()
		}
	}()
}

func flush() {}

// accept starts a goroutine per connection: not jobs.
func accept() {
	ln, err := net.Listen("tcp", ":9000")
	if err != nil {
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go handle(c)
	}
}

func handle(c net.Conn) {
	msgs := make(chan []byte)
	for m := range msgs {
		_, _ = c.Write(m)
	}
}

func init() {
	_ = notify.Hook(notify.Settings{})
	_ = fetch.Ping()
	_ = notify.Items()
	_ = notify.Local("1")
}
