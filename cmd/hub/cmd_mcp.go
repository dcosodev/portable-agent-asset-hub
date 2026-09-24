package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"hub/internal/mcp"
	"hub/internal/output"
)

// McpFlags is the deliberately narrow T7 CLI surface.
type McpFlags struct {
	Launch bool
	Stdio  bool
	Help   bool
}

func parseMcpFlags(argv []string) (McpFlags, error) {
	var flags McpFlags
	for _, arg := range argv {
		switch arg {
		case "launch":
			if flags.Launch {
				return flags, errors.New("hub mcp: launch specified twice")
			}
			flags.Launch = true
		case "--stdio":
			if flags.Stdio {
				return flags, errors.New("hub mcp: --stdio specified twice")
			}
			flags.Stdio = true
		case "--help", "-h":
			flags.Help = true
		default:
			return flags, fmt.Errorf("hub mcp: unknown argument %q", arg)
		}
	}
	if !flags.Help && (!flags.Launch || !flags.Stdio) {
		return flags, errors.New("hub mcp: usage is `hub mcp launch --stdio`")
	}
	return flags, nil
}

// resolveMcpCommand returns the existing TypeScript MCP entrypoint. The
// explicit HUB_MCP_COMMAND override is intended for hermetic tests and is
// never interpreted as shell text: it is one executable path only.
func resolveMcpCommand() (string, []string, error) {
	if override := strings.TrimSpace(os.Getenv("HUB_MCP_COMMAND")); override != "" {
		if !filepath.IsAbs(override) {
			return "", nil, errors.New("hub mcp: HUB_MCP_COMMAND must be an absolute executable path")
		}
		if _, err := os.Stat(override); err != nil {
			return "", nil, fmt.Errorf("hub mcp: HUB_MCP_COMMAND: %w", err)
		}
		if strings.HasSuffix(override, ".mjs") || strings.HasSuffix(override, ".js") {
			node, err := exec.LookPath("node")
			if err != nil {
				return "", nil, fmt.Errorf("hub mcp: node is unavailable: %w", err)
			}
			return node, []string{override}, nil
		}
		return override, nil, nil
	}
	candidates := []string{
		filepath.Join(repoRoot, "packages", "mcp", "bin", "agent-memory-mcp.mjs"),
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "packages", "mcp", "bin", "agent-memory-mcp.mjs"))
	}
	for _, entry := range candidates {
		if info, err := os.Stat(entry); err == nil && !info.IsDir() {
			node, err := exec.LookPath("node")
			if err != nil {
				return "", nil, fmt.Errorf("hub mcp: node is unavailable: %w", err)
			}
			return node, []string{entry}, nil
		}
	}
	return "", nil, errors.New("hub mcp: existing TypeScript MCP entrypoint not found")
}

func runMcp(sink *output.Sink, stdin io.Reader, stdout, stderr io.Writer, rest []string, jsonFlag bool) (int, error) {
	flags, err := parseMcpFlags(rest)
	if err != nil {
		emitError(sink, "%v", err)
		return exitContractViolation, nil
	}
	if flags.Help {
		printMcpHelp(sink)
		return exitOK, nil
	}
	command, args, err := resolveMcpCommand()
	if err != nil {
		emitError(sink, "%v", err)
		return exitOperatorError, nil
	}
	sup := mcp.NewSupervisor(mcp.SupervisorConfig{
		Command:      command,
		Args:         args,
		Env:          os.Environ(),
		Backoff:      mcp.BackoffConfig{Min: 50 * time.Millisecond, Max: 400 * time.Millisecond, MaxAttempts: 5},
		StderrPrefix: "mcp-supervisor",
	})
	sup.SetStdin(stdin)
	sup.SetStdout(stdout)
	sup.SetStderr(stderr)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := sup.Run(ctx); err != nil {
		emitError(sink, "hub mcp: %v", err)
		if code := sup.ExitCode(); code > 0 {
			return code, nil
		}
		return exitOperatorError, nil
	}
	if jsonFlag {
		_ = sink.Printf(`{"command":"mcp launch --stdio","status":"stopped","exit_code":%d}`, sup.ExitCode())
	}
	return sup.ExitCode(), nil
}

func printMcpHelp(sink *output.Sink) {
	for _, line := range []string{
		"hub mcp — supervise the existing TypeScript MCP",
		"",
		"Usage:",
		"  hub mcp launch --stdio",
		"",
		"The Go shell forwards stdin/stdout without transforming MCP payloads.",
		"The TypeScript MCP under packages/mcp is the single implementation.",
	} {
		_ = sink.Printf("%s", line)
	}
	_ = sink.Printf("")
}
