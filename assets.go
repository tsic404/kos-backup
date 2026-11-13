// Package kosbackup is the kos-backup system application: the extension
// declaration it installs as, the `App` window it contributes, and the package
// built from the two (KOSD-C-17, KOSD-C-73).
package kosbackup

import (
	"embed"
	"io/fs"
	"sort"

	"github.com/tsic404/kos-sdk/packaging"
)

// assetTree is the UI asset set the package ships. It is embedded so the pack
// entry, the manifest check and the acceptance cases all read the same bytes:
// a digest that covered a directory listing but not these bytes would not be
// the package's digest (SDK-C-4).
//
//go:embed all:assets
var assetTree embed.FS

// AssetRoot is the package-relative directory UI assets live in (SDK-C-4).
const AssetRoot = "assets"

// Assets returns every UI asset the package carries, in path order. The icon
// the manifest names is one of them, so the manifest and the package cannot
// disagree about what the window ships (KOSD-C-73).
func Assets() ([]packaging.Asset, error) {
	var assets []packaging.Asset
	err := fs.WalkDir(assetTree, AssetRoot, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		content, err := assetTree.ReadFile(name)
		if err != nil {
			return err
		}
		assets = append(assets, packaging.Asset{Path: name, Content: content})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(assets, func(left, right int) bool { return assets[left].Path < assets[right].Path })
	return assets, nil
}
