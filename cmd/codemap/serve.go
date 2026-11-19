package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/blatessa/codemap/internal/build"
	"github.com/blatessa/codemap/internal/server"
	"github.com/blatessa/codemap/internal/web"
)

func init() { commands["serve"] = runServe }

// viewerAssets returns the embedded viewer. The server uses dist/ inside it.
// Extractors register in build.Extractors (extractors.go).
func viewerAssets() fs.FS { return web.Dist }

// runServe implements `codemap serve [--root .] [--graph FILE] [--addr 127.0.0.1] [--port 7777] [--no-open]`.
func runServe(args []string) error {
	fset := flag.NewFlagSet("serve", flag.ContinueOnError)
	root := fset.String("root", ".", "repo root")
	graphFile := fset.String("graph", "", "read this graph.json instead of running the extractors")
	addr := fset.String("addr", "127.0.0.1", "address to listen on")
	port := fset.Int("port", 7777, "port to listen on")
	noOpen := fset.Bool("no-open", false, "don't open the browser")
	if err := fset.Parse(args); err != nil {
		return err
	}
	if fset.NArg() > 0 {
		return fmt.Errorf("serve: unexpected argument %q", fset.Arg(0))
	}
	srv, err := server.New(server.Options{Root: *root, GraphFile: *graphFile, Assets: viewerAssets(), Addr: *addr, Deferred: *graphFile == ""})
	if errors.Is(err, build.ErrNoExtractors) {
		return errors.New("serve: no extractors are wired in yet; pass --graph FILE (for example testdata/shop.expected.json)")
	}
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	defer srv.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Watch(ctx); err != nil {
		return fmt.Errorf("serve: watch: %w", err)
	}
	listen := net.JoinHostPort(*addr, strconv.Itoa(*port))
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	url := "http://" + listen + "/"
	if ip := net.ParseIP(*addr); ip != nil && ip.IsUnspecified() {
		url = "http://localhost:" + strconv.Itoa(*port) + "/"
	}
	fmt.Fprintf(os.Stderr, "codemap: serving %s at %s\n", srv.Root(), url)
	if !*noOpen {
		openBrowser(url)
	}
	// Build after the listener is up: the browser opens at once and shows the
	// map as soon as the first build finishes.
	go func() {
		start := time.Now()
		if err := srv.Build(); err != nil {
			fmt.Fprintf(os.Stderr, "codemap: build: %v\n", err)
			return
		}
		fmt.Fprintf(os.Stderr, "codemap: built the map in %s\n", time.Since(start).Round(time.Millisecond))
	}()
	hs := &http.Server{Handler: srv.Handler()}
	go func() {
		<-ctx.Done()
		hs.Close()
	}()
	if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

func openBrowser(url string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	cmd := exec.Command(name, url)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "codemap: open browser: %v\n", err)
		return
	}
	go cmd.Wait()
}
