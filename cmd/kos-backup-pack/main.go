// Command kos-backup-pack writes the kos-backup artifact and prints the digest
// an install request names (KOSD-C-17). It is the build entry the Makefile and
// the release use; it reads no product identity and no install source, so the
// bytes it writes are the same bytes any author would get from the same
// declaration and assets (SDK-C-4).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tsic404/kos-backup"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	out := flag.String("out", "dist", "directory the artifact is written to")
	flag.Parse()

	pkg, archive, err := kosbackup.Package()
	if err != nil {
		return fmt.Errorf("pack %s: %w", kosbackup.ExtensionID, err)
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", *out, err)
	}
	name := fmt.Sprintf("%s-%s.tar.gz", pkg.Manifest.ID, pkg.Manifest.Version)
	target := filepath.Join(*out, name)
	if err := os.WriteFile(target, archive, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", target, err)
	}
	fmt.Printf("%s %s\n", target, pkg.Digest)
	return nil
}
