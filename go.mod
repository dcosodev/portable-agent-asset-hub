// Private Go module for the hub product shell. The module name is
// `hub` (no domain suffix) because the binary is the canonical product
// shell — see docs/phase0/naming.md. The module deliberately has
// `go 1.24.3` as the floor so that `go build` on the installed
// `go1.24.3 darwin/arm64` toolchain is reproducible and reproducible
// builds with `-trimpath` are guaranteed byte-identical across hosts.
//
// Per T0.5 scope this module ships ZERO external dependencies. The Go
// standard library covers every need for the shell's first slice
// (version constant, stdout/stderr separation, env-driven config,
// xdg-style paths on macOS). Adding a third-party dependency at this
// stage would shrink the diff and broaden the audit surface without
// paying for any feature.
module hub

go 1.24.3
