package kosbackup

import (
	"github.com/tsic404/kos-sdk/packaging"
)

// Package builds the artifact the install path consumes: the declaration, the
// UI assets the declaration names, and the digest that covers both. It goes
// through the SDK packer so a first-party system application and a third-party
// extension take the same path and produce the same structure (SDK-C-1,
// SDK-C-4).
//
// A rejected declaration or an asset the declaration does not carry yields an
// error and no artifact, so this product cannot hold an installable package the
// framework would refuse (SDK-C-3).
func Package() (packaging.Package, []byte, error) {
	declaration, err := Declaration()
	if err != nil {
		return packaging.Package{}, nil, err
	}
	assets, err := Assets()
	if err != nil {
		return packaging.Package{}, nil, err
	}
	return packaging.Pack(declaration, assets)
}
