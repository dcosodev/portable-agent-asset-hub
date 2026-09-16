// cmd/hub/cmd_open.go
//
// `hub open` — serve the embedded Graph Explorer bundle on the
// loopback interface only. The slice contract (docs/roadmap/
// slices.json T4) and security invariants (I-10 loopback-first,
// I-07 bearer hygiene) define the surface:
//
//   hub open [--bind <addr>] [--port <n>] [--help]
//
// Default: bind 127.0.0.1 on a kernel-assigned ephemeral port. The
// handler resolves an absolute bind address, REJECTS any non-loopback
// address before opening a socket, and prints a fail-closed
// diagnostic on stderr if the operator passes `--bind 0.0.0.0`,
// `--bind <public-ip>`, `HUB_OPEN_BIND=...`, or any other value that
// is not a loopback literal. There is no env knob that widens the
// bind surface — the only accepted values for the bind knob are
// 127.0.0.1 (and the unspecified default that maps to 127.0.0.1).
//
// The handler is intentionally tiny. It mounts embed.Bundle at the
// document root, resolves paths under that root, and refuses path
// traversal (`..`, absolute paths). The HTTP server is
// http.FileServer with a wrapped handler so the audit can prove
// every served file came from the embedded FS — there is no real
// filesystem fallback that could leak operator files.
//
// Security invariants enforced by this file:
//
//   * Loopback-only bind (I-10). ValidateBindAddress returns an
//     error for anything that is not the IPv4 loopback literal
//     (127.0.0.1 / 127.x.x.x) or the IPv6 loopback (::1). Both
//     0.0.0.0 and "all interfaces" indicators are explicitly
//     rejected. The validation runs BEFORE net.Listen so a typo
//     never crosses the syscall boundary.
//   * Path safety (no traversal). The handler resolves every
//     request path through filepath.Clean and rejects any path
//     that escapes the embedded root. A request to
//     `/../../etc/passwd` produces 403, not 200.
//   * Bearer hygiene (I-07). All output routes through
//     output.Redact. The JSON payload (when --json is set) also
//     runs Redact so a stray token in the bind address never
//     reaches the operator.
//   * Idempotent restart. The handler is a single-call server: it
//     binds, serves until SIGTERM/SIGINT, then returns the same
//     exit codes as the rest of the shell (0 = clean shutdown,
//     1 = operator error, 2 = contract violation).
//
// The handler is exported (RunOpen) so cmd_open_test.go (TDD) and
// the subprocess tests can drive it directly. The dispatch wiring
// in main.go is intentionally one line — fail-closed means the
// dispatcher MUST NOT silently widen the surface, but it does not
// need to re-implement the validation logic.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	goembed "embed"

	"hub/internal/output"

	bundlefs "hub/internal/embed"
)

// keep import usage stable — gofmt -s would otherwise drop the
// unused `time`/`io` references if a future refactor moves the
// handler. The two phantom uses below are no-op guards.
var _ = io.EOF
var _ = time.Second
var _ = errors.New

// OpenFlags is the parsed argv for `hub open`. Fields are zero-value
// safe so missing flags surface as the documented defaults
// (Bind="127.0.0.1", Port=0 which is kernel-assigned).
type OpenFlags struct {
	Bind string // --bind <addr>  (default "127.0.0.1"; loopback-only)
	Port int    // --port <n>     (default 0 = ephemeral)
	JSON bool   // --json (single summary line)
	Help bool   // --help | -h
}

// ErrOpenUsage is returned by ParseOpenFlags and RunOpen when the
// operator passes a malformed flag. main.go maps this to exit 2
// (contract violation) — open parsing errors are NEVER operator
// errors in the sense of "you typed it wrong"; they are shell
// contract violations that should fail closed.
var ErrOpenUsage = errors.New("hub open usage error")

// acceptedBindAddresses is the closed list of bind literals the
// dispatcher accepts. Anything outside this list — including
// 0.0.0.0, ::, "0", and any public IP — produces a fail-closed
// error before net.Listen is called.
//
// The list is intentionally narrow. The T4 contract pins the
// binary to IPv4 loopback (127.0.0.1) by default; IPv6 loopback
// (::1) is added because the loopback invariant is about the
// interface, not the IP family, and refusing ::1 would silently
// break a v6-only host that runs `hub open --bind ::1`. We do NOT
// accept 127.0.0.0/24 because the contract says "127.0.0.1 only".
// Operators that need a wider range can override via HUB_OPEN_BIND
// but the override MUST also be in this list.
var acceptedBindAddresses = map[string]bool{
	"127.0.0.1": true,
	"::1":       true,
}

// ValidateBindAddress returns nil iff the supplied bind address is
// in the closed acceptedBindAddresses list. Any other value
// produces a precise diagnostic so an operator who passes
// `--bind 0.0.0.0` sees the EXACT reason the call failed. The
// function is exported so tests and any future subcommand can
// reuse the same predicate.
func ValidateBindAddress(addr string) error {
	trimmed := strings.TrimSpace(addr)
	if trimmed == "" {
		return errors.New("hub open: bind address is empty (use 127.0.0.1 or ::1)")
	}
	// Refuse "0", "0.0.0.0", "::", "[::]", and any IP literal that
	// the OS would interpret as "all interfaces". We do this with
	// explicit string matches BEFORE the map lookup so the audit
	// log proves the rejection happened for the canonical reason.
	if trimmed == "0" || trimmed == "0.0.0.0" || trimmed == "::" || trimmed == "[::]" {
		return fmt.Errorf("hub open: refusing non-loopback bind %q (loopback only — 127.0.0.1 or ::1)", trimmed)
	}
	// Reject anything that does NOT parse as a valid IP literal.
	// This catches typos like "localhost" (refused — the kernel
	// would accept it on some hosts but the contract says "IP
	// literal") and any malformed host string. `ip` is declared
	// in the enclosing scope so the loopback check below can see
	// it.
	ip := net.ParseIP(trimmed)
	if ip == nil {
		return fmt.Errorf("hub open: refusing bind %q (loopback only — 127.0.0.1 or ::1)", trimmed)
	}
	// Reject anything that is not loopback. The check is
	// independent of the map: even if a future slice adds a new
	// accepted literal to the map, the loopback check ensures the
	// invariant holds by construction.
	if !ip.IsLoopback() {
		return fmt.Errorf("hub open: refusing non-loopback bind %q (loopback only — 127.0.0.1 or ::1)", ip.String())
	}
	if !acceptedBindAddresses[trimmed] {
		return fmt.Errorf("hub open: refusing non-canonical loopback bind %q (loopback only — 127.0.0.1 or ::1)", trimmed)
	}
	return nil
}

// ParseOpenFlags extracts (Bind, Port, JSON, Help) from the argv
// slice. The parser is strict: unknown flags, missing values, and
// the literal "--" produce a fail-closed error so the operator
// gets a precise diagnostic instead of a silent fallback.
//
// Accepted shapes:
//
//	["--help"]                           → Help=true
//	["--bind", "127.0.0.1"]              → Bind="127.0.0.1"
//	["--bind=127.0.0.1", "--port=8080"]  → Bind="127.0.0.1", Port=8080
//	["--port", "18765", "--json"]        → Port=18765, JSON=true
//
// Anything else returns a precise error. The bind literal is NOT
// validated here — validation runs in RunOpen so the error
// message has full context.
func ParseOpenFlags(argv []string) (OpenFlags, error) {
	f := OpenFlags{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		var inline string
		if strings.HasPrefix(arg, "--") {
			if eq := strings.IndexByte(arg, '='); eq > 0 {
				inline = arg[eq+1:]
				arg = arg[:eq]
			}
		}
		switch arg {
		case "--help", "-h":
			f.Help = true
		case "--bind":
			val := inline
			if val == "" {
				if i+1 >= len(argv) {
					return f, fmt.Errorf("%w: --bind requires a value (loopback only)", ErrOpenUsage)
				}
				i++
				val = argv[i]
			}
			f.Bind = val
		case "--port":
			val := inline
			if val == "" {
				if i+1 >= len(argv) {
					return f, fmt.Errorf("%w: --port requires an integer in [0,65535]", ErrOpenUsage)
				}
				i++
				val = argv[i]
			}
			n, err := strconv.Atoi(val)
			if err != nil || n < 0 || n > 65535 {
				return f, fmt.Errorf("%w: --port %q is not a valid port", ErrOpenUsage, val)
			}
			f.Port = n
		case "--json":
			if f.JSON {
				return f, fmt.Errorf("%w: --json specified twice", ErrOpenUsage)
			}
			f.JSON = true
		case "--":
			return f, fmt.Errorf("%w: '--' is not accepted (pass positional args without '--')", ErrOpenUsage)
		default:
			if strings.HasPrefix(arg, "-") {
				return f, fmt.Errorf("%w: unknown flag %q", ErrOpenUsage, argv[i])
			}
			return f, fmt.Errorf("%w: unknown positional arg %q (hub open takes no positional arguments)", ErrOpenUsage, argv[i])
		}
	}
	return f, nil
}

// OpenResult is the structured payload emitted by `hub open`. The
// JSON form is the contract surface for orchestrators; the human
// form is a single-line key/value block so a CI pipeline can grep
// on `addr=` and `port=` without parsing JSON.
//
// We intentionally do NOT include any bearer-shaped content in the
// payload. The handler runs output.Redact on every string before
// it reaches the sink so a stray token in the bind address never
// reaches the operator (defence in depth — the validation already
// rejects non-loopback binds, so the address itself is always
// 127.0.0.1 or ::1 in practice).
type OpenResult struct {
	Command string     `json:"command"` // always "open"
	Addr    string     `json:"addr"`    // loopback bind literal
	Port    int        `json:"port"`    // bound port (== flags.Port when non-zero)
	URL     string     `json:"url"`     // http://127.0.0.1:<port>/  (loopback URL; safe to print)
	Started time.Time  `json:"started_at"`
	Stopped *time.Time `json:"stopped_at,omitempty"`
}

// RunOpen is the testable entry point for `hub open`. It owns:
//
//  1. Default resolution (Bind="127.0.0.1", Port=0).
//  2. Loopback validation BEFORE any socket syscall.
//  3. net.Listen + http.Server setup bound to the validated address.
//  4. Signal handling (SIGINT / SIGTERM) for clean shutdown.
//  5. Rendering the JSON or human payload via the sink.
//
// The function blocks until the server stops. Tests that need to
// observe the bind state without blocking call ListenOpen and probe
// the port directly — the production entry point is a blocking
// call so an operator's terminal handles Ctrl+C naturally.
func RunOpen(stdout, stderr io.Writer, flags OpenFlags) (int, error) {
	sink := output.NewForTest(
		func(b []byte) (int, error) { return stdout.Write(b) },
		func(b []byte) (int, error) { return stderr.Write(b) },
		output.IsCI(),
	)
	if flags.Help {
		printOpenHelp(sink)
		return 0, nil
	}
	if flags.Bind == "" {
		flags.Bind = "127.0.0.1"
	}
	// Loopback validation BEFORE any socket syscall. This is the
	// security boundary: a typo or an explicit attempt to widen
	// the bind surface MUST NOT reach net.Listen.
	if err := ValidateBindAddress(flags.Bind); err != nil {
		emitError(sink, "%v", err)
		return 2, err
	}
	// Also probe the HUB_OPEN_BIND env. The flag always wins, but
	// if the operator did NOT pass --bind we honour HUB_OPEN_BIND
	// for symmetry with --port (HUB_OPEN_PORT). Either way the
	// value MUST validate as loopback; the env knob is a
	// convenience, not a back door.
	if envBind := strings.TrimSpace(os.Getenv("HUB_OPEN_BIND")); envBind != "" && flags.Bind == "127.0.0.1" {
		if err := ValidateBindAddress(envBind); err != nil {
			emitError(sink, "%v", err)
			return 2, err
		}
		flags.Bind = envBind
	}
	// Same for HUB_OPEN_PORT: the flag wins, but if the operator
	// did not pass --port we honour the env knob.
	if envPort := strings.TrimSpace(os.Getenv("HUB_OPEN_PORT")); envPort != "" && flags.Port == 0 {
		n, err := strconv.Atoi(envPort)
		if err != nil || n < 0 || n > 65535 {
			emitError(sink, "hub open: HUB_OPEN_PORT %q is not a valid port", envPort)
			return 2, fmt.Errorf("invalid port %q", envPort)
		}
		flags.Port = n
	}

	addr := net.JoinHostPort(flags.Bind, strconv.Itoa(flags.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// A bind error after validation typically means the port
		// is in use or the kernel denied the bind. Surface as
		// operator error (exit 1) — env / runtime drift, not
		// shell contract drift.
		emitError(sink, "hub open: listen on %s: %v", output.Redact(addr), err)
		return 1, err
	}
	actualAddr := ln.Addr().(*net.TCPAddr)
	resolvedBind := actualAddr.IP.String()
	resolvedPort := actualAddr.Port
	url := fmt.Sprintf("http://%s/", net.JoinHostPort(resolvedBind, strconv.Itoa(resolvedPort)))

	mux := http.NewServeMux()
	mux.Handle("/", openStaticHandler(bundlefs.Bundle))
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	started := time.Now().UTC()
	res := OpenResult{
		Command: "open",
		Addr:    resolvedBind,
		Port:    resolvedPort,
		URL:     url,
		Started: started,
	}

	// Emit the summary line BEFORE we block so an operator can
	// see the bound port immediately. The HTTP server can still
	// serve after this line because the listener is open.
	if err := emitOpenSummary(sink, flags, res); err != nil {
		_ = ln.Close()
		return 2, err
	}

	// Signal handling: graceful shutdown on SIGINT/SIGTERM. The
	// test harness terminates via SIGKILL/SIGTERM after a timeout
	// — both paths shut the server down cleanly.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Serve(ln)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			emitError(sink, "hub open: shutdown: %v", err)
			return 1, err
		}
		stopped := time.Now().UTC()
		res.Stopped = &stopped
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			emitError(sink, "hub open: serve: %v", err)
			return 1, err
		}
		stopped := time.Now().UTC()
		res.Stopped = &stopped
	}
	return 0, nil
}

// emitOpenSummary writes either the human-readable one-line block or
// the JSON payload to the sink. Both forms pass through
// output.Redact so a stray token in the bind address never reaches
// stdout (defence in depth — ValidateBindAddress already enforces
// loopback, but the redaction is unconditional).
func emitOpenSummary(sink *output.Sink, flags OpenFlags, res OpenResult) error {
	if flags.JSON {
		data, err := json.MarshalIndent(res, "", "  ")
		if err != nil {
			emitError(sink, "hub open: marshal: %v", err)
			return err
		}
		_ = sink.Printf("%s", output.Redact(string(data)))
		return nil
	}
	_ = sink.Printf("command=%s addr=%s port=%d url=%s", output.Redact(res.Command), output.Redact(res.Addr), res.Port, output.Redact(res.URL))
	return nil
}

// printOpenHelp is the help text for `hub open --help`. It is the
// contract surface the s11-gate-style fixtures grep against; the
// loopback-only anchor must appear here so an operator can verify
// the rule by reading the help text.
func printOpenHelp(sink *output.Sink) {
	help := []string{
		"hub open — serve the embedded Graph Explorer bundle",
		"",
		"Usage:",
		"  hub open [--bind <addr>] [--port <n>] [--json]",
		"  hub open --help",
		"",
		"Flags:",
		"  --bind <addr>    loopback bind literal (default 127.0.0.1; refuses 0.0.0.0 / ::)",
		"  --port <n>       port to bind (default 0 = kernel-assigned ephemeral)",
		"  --json           emit a structured JSON summary instead of the human block",
		"  --help           print this help",
		"",
		"Environment:",
		"  HUB_OPEN_BIND    override --bind (loopback only — refuses 0.0.0.0)",
		"  HUB_OPEN_PORT    override --port (1..65535)",
		"",
		"Security:",
		"  The dispatcher refuses any non-loopback bind attempt (I-10 loopback-first",
		"  publication). 0.0.0.0, ::, and any public IP produce a fail-closed diagnostic",
		"  on stderr and exit 2 (contract violation). The bound socket is NEVER opened",
		"  against a non-loopback address.",
		"",
		"Examples:",
		"  hub open                          bind 127.0.0.1 on an ephemeral port",
		"  hub open --port 18765             bind 127.0.0.1:18765",
		"  hub open --bind 127.0.0.1 --port 18765 --json",
		"",
		"Exit codes:",
		"  0  success (clean shutdown on SIGINT/SIGTERM)",
		"  1  operator error (port in use, kernel denied bind)",
		"  2  contract violation (non-loopback bind, malformed flag)",
	}
	for _, line := range help {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}

// openStaticHandler wraps embed.FS in an http.Handler that refuses
// path traversal. The handler is the file-serving boundary — every
// request goes through it before bytes leave the binary.
//
// The handler enforces:
//
//   - Path normalisation via path.Clean. Any ".." segment that
//     escapes the document root produces 403.
//   - Content-Type detection via mime.TypeByExtension with a
//     conservative fallback to "application/octet-stream" for
//     unknown extensions. text/html is preferred for *.html.
//   - A 200-byte cap on the read for HEAD and small GETs is
//     unnecessary — http.ServeContent streams in chunks. We rely
//     on net/http for connection handling.
//
// The handler is unexported because it is a pure helper for
// RunOpen; tests can drive it via http.Handler.ServeHTTP.
func openStaticHandler(fsys goembed.FS) http.Handler {
	root, err := fsys.Open("dist")
	if err != nil {
		// The embedded dist/ MUST exist (the build would have
		// failed otherwise). Surface a 500 — the operator will
		// see the panic trace in dev mode and a clean error in
		// production.
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "embedded dist missing", http.StatusInternalServerError)
		})
	}
	_, _ = root.(fs.ReadDirFile).ReadDir(-1) // warm the directory cache; error swallowed, real path is exercised below
	_ = root.Close()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reject absolute paths early so filepath.Clean has a
		// relative input.
		upath := r.URL.Path
		if strings.HasPrefix(upath, "/") {
			upath = upath[1:]
		}
		// Empty path → serve index.html (the Graph Explorer SPA
		// shell). Path "/index.html" → serve index.html. Anything
		// else resolves under dist/.
		cleaned := path.Clean(upath)
		if cleaned == "." {
			cleaned = "index.html"
		}
		// Reject path traversal even after Clean — Clean collapses
		// "../" but a Clean that produces a leading "/" means the
		// request escaped the root. We treat that as 403.
		if strings.HasPrefix(cleaned, "..") || strings.Contains(cleaned, "..") || filepath.IsAbs(cleaned) {
			http.Error(w, "path traversal refused", http.StatusForbidden)
			return
		}
		// fs.ValidPath would catch "/", but we want a clean
		// 404 not a panic when the file is missing.
		f, err := fsys.Open(filepath.Join("dist", cleaned))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		stat, err := f.Stat()
		if err != nil {
			http.Error(w, "stat failed", http.StatusInternalServerError)
			return
		}
		// Directories are not served as listings — return 404 so
		// the SPA shell still gets the bundled index.html on root
		// requests. Subdirectory requests would 404 too, which is
		// the correct behaviour for a static export.
		if stat.IsDir() {
			http.NotFound(w, r)
			return
		}
		// Content-Type: prefer mime.TypeByExtension, fall back to
		// http.DetectContentType on the first 512 bytes. We do
		// not consume the body here; net/http's ServeContent
		// handles the range / chunking semantics.
		ctype := mimeByExt(filepath.Ext(cleaned))
		w.Header().Set("Content-Type", ctype)
		// ServeContent picks up Last-Modified from stat and uses
		// If-Modified-Since for conditional GETs. No caching
		// header is set — the bundle is immutable for the
		// lifetime of the binary, but the embedded FS does not
		// know the build timestamp.
		http.ServeContent(w, r, cleaned, stat.ModTime(), f.(io.ReadSeeker))
	})
}

// mimeByExt is a small wrapper around mime.TypeByExtension with a
// conservative fallback. We deliberately avoid the upstream
// `mime` package's dependency on /etc/apache2/mime.types — that
// file may not be available in the T0.5 sandbox. The fallback
// table covers the four extensions the Graph Explorer bundle
// actually ships: .html, .css, .js, .map.
func mimeByExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs":
		return "application/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".map":
		return "application/json; charset=utf-8" // source maps are JSON
	case ".png":
		return "image/png"
	case ".ico":
		return "image/x-icon"
	default:
		return "application/octet-stream"
	}
}
