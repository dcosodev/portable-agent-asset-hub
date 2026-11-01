// Private Go module for the hub product shell. The module name is
// `hub` (no domain suffix) because the binary is the canonical product
// shell — see docs/architecture/go-product-shell.md. The module has
// `go 1.24.3` as the floor.
//
// This module has no external dependencies; the Go standard library
// covers what the shell needs.
module hub

go 1.24.3
