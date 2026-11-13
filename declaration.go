package kosbackup

import (
	"encoding/json"
	"fmt"

	"github.com/tsic404/kos-sdk/manifest"
)

// The product identity the declaration and its one `App` carry. The version is
// the application version UI assets are addressed by (KOSD-C-73).
const (
	// ExtensionID is the extension identity: the identifier the install request
	// and the system component report (KOSD-C-17).
	ExtensionID = "kos-backup"
	// Version is this artifact's version.
	Version = "0.1.0"
	// FrameworkVersion is the framework API range this declaration targets; the
	// kernel serves 1.1 (KOSD-C-16).
	FrameworkVersion = ">=1.1 <2.0"
	// AppID is the `App` identity inside the installed extension (KOSD-C-73).
	AppID = "kos-backup"
	// AppOrigin is the application origin the window document is served from.
	// KOSD-C-73 fixes it as an origin of its own, apart from the console.
	AppOrigin = "https://backup.apps.kos.tsic.top"
	// AppEntry is the window document address on AppOrigin.
	AppEntry = AppOrigin + "/index.html"
	// AppIcon is the package-relative icon asset the manifest names.
	AppIcon = AssetRoot + "/icon.svg"
	// HostComponent is the component the window is hosted by: the desktop owns
	// the launcher, the window frame and the handshake (DASH-C-30).
	HostComponent = "kos-dashboard"
)

// APIGroup is the kernel group the window reads and writes (KOSD-C-41).
const APIGroup = "kos.tsic.top"

// App returns the `App` window declaration of KOSD-C-73. The window field set is
// exactly the seven the contract fixes, the permission set is empty (the window
// uses no notification, clipboard, file-picker or external-link capability) and
// `backend` is absent: the product owns no data plane, so it is UI-only and its
// data comes from the control plane (KOSD-C-12).
func App() manifest.AppManifest {
	return manifest.AppManifest{
		ID:      AppID,
		Name:    "备份",
		Version: Version,
		Icon:    AppIcon,
		Entry:   AppEntry,
		Window: manifest.AppWindow{
			Width:        1080,
			Height:       720,
			MinWidth:     840,
			MinHeight:    560,
			Resizable:    true,
			Mode:         "single",
			DefaultState: "normal",
		},
		Permissions: []manifest.Permission{},
	}
}

// Declaration returns the extension declaration of KOSD-C-18 as the author-side
// document the packer validates. It declares one contribution class, `apps`,
// and no object class, controller, page, setting, catalog source, discovery
// adapter, diagnostic adapter or preference structure: the backup policy and
// restore job objects belong to the kernel and their reconcilers to kosd.
func Declaration() (map[string]any, error) {
	app, err := appDocument()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id":               ExtensionID,
		"version":          Version,
		"frameworkVersion": FrameworkVersion,
		"contributions": map[string]any{
			"apps": []any{app},
		},
		"dependencies": map[string]any{
			"components": []any{map[string]any{"id": HostComponent}},
		},
		"permissions": map[string]any{
			"read": []any{
				map[string]any{
					"apiGroup":  APIGroup,
					"resources": []any{"backuppolicies", "restorejobs", "applications", "volumes"},
				},
			},
			"write": []any{
				map[string]any{
					"apiGroup":  APIGroup,
					"resources": []any{"restorejobs"},
					"verbs":     []any{"create"},
				},
			},
			"roles": []any{"Owner", "Member"},
		},
		"config": map[string]any{},
		"status": map[string]any{},
		"uninstallRetention": map[string]any{
			"contributions": map[string]any{"apps": "delete"},
		},
	}, nil
}

// appDocument renders the App declaration as the JSON object the declaration
// carries, so the manifest is written once, typed, instead of as a hand-built
// map that could drift from KOSD-C-73.
func appDocument() (map[string]any, error) {
	encoded, err := json.Marshal(App())
	if err != nil {
		return nil, fmt.Errorf("encode App declaration: %w", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		return nil, fmt.Errorf("decode App declaration: %w", err)
	}
	return document, nil
}
