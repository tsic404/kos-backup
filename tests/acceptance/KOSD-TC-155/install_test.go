// Package kosdtc155 verifies KOSD-AC-72 / KOSD-TC-155 for kos-backup: the
// product is one extension artifact installed as a system component, its window
// appears while the component is installed and disappears when it is removed,
// and neither the other installed product nor any kernel object is touched.
//
// The case walks the same two seams a deployment uses: the install request is a
// control-plane write of a SystemComponent (KOSD-C-17, KOSD-C-12), and the
// window is what the desktop's application host reports for the installed
// contributions it is given (KOSD-C-73, DASH-C-30). The contribution report is
// assembled here the way the kernel assembles it — verify the artifact against
// the digest the component names, then hand every declared App to the host —
// because the kernel's install pipeline is another project and this product
// owns only its artifact.
package kosdtc155

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/tsic404/kos-backup"
	"github.com/tsic404/kos-dashboard/pkg/apphost"
	"github.com/tsic404/kos-sdk/client"
	"github.com/tsic404/kos-sdk/packaging"
)

const (
	consoleOrigin = "https://console.kos.tsic.top"
	apiRoot       = "/api/v1/resources/"
	// componentKind is the one install object class: there is no dedicated
	// installation channel for a system application (KOSD-C-17).
	componentKind = "SystemComponent"
	// otherExtension is a second installed system application, so a case can
	// show that installing and removing this product leaves it alone.
	otherExtension = "kos.example.files"
	// applicationName is a kernel object the case holds unchanged across
	// install and uninstall.
	applicationName = "media"
)

var observedAt = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

// axisObject is the kernel object the case reads before and after: installing or
// removing a window application must not touch it (KOSD-AC-72).
func axisObject() map[string]any {
	return map[string]any{
		"apiVersion": "kos.tsic.top/v1beta1",
		"kind":       "Application",
		"metadata": map[string]any{
			"name":      applicationName,
			"namespace": "home",
			"uid":       "0d1f-contract-fixture",
		},
		"spec": map[string]any{"definition": "media", "replicas": float64(1)},
	}
}

// controlPlane is the API the case calls: objects as resources, with the
// projection envelope of KOSD-C-13 and the acceptance answer of KOSD-C-12.
type controlPlane struct {
	mu      sync.Mutex
	objects map[string][]map[string]any
	writes  []string
}

func newControlPlane() *controlPlane {
	plane := &controlPlane{objects: map[string][]map[string]any{}}
	plane.objects["Application"] = []map[string]any{axisObject()}
	return plane
}

func (p *controlPlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()

	kind, rest := splitResourcePath(r.URL.Path)
	if kind == "" {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error": map[string]any{"code": "not-found", "message": "没有这个接口", "stage": "read"},
		})
		return
	}
	switch {
	case r.Method == http.MethodGet && rest == "":
		items := make([]map[string]any, 0, len(p.objects[kind]))
		for _, object := range p.objects[kind] {
			items = append(items, projectionOf(kind, object))
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	case r.Method == http.MethodPost && rest == "":
		var object map[string]any
		if err := json.NewDecoder(r.Body).Decode(&object); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": map[string]any{"code": "invalid-body", "message": "请求体不是对象", "stage": "write"},
			})
			return
		}
		name := nestedString(object, "metadata", "name")
		if name == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": map[string]any{"code": "invalid-body", "message": "对象没有名字", "stage": "write"},
			})
			return
		}
		p.objects[kind] = append(p.objects[kind], object)
		p.writes = append(p.writes, "create "+kind+"/"+name)
		writeJSON(w, http.StatusOK, map[string]any{"accepted": true, "ref": refOf(kind, object)})
	case r.Method == http.MethodDelete && rest != "":
		kept := p.objects[kind][:0]
		found := false
		for _, object := range p.objects[kind] {
			if nestedString(object, "metadata", "name") == rest {
				found = true
				continue
			}
			kept = append(kept, object)
		}
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]any{
				"error": map[string]any{"code": "not-found", "message": "对象不存在", "stage": "write"},
			})
			return
		}
		p.objects[kind] = kept
		p.writes = append(p.writes, "delete "+kind+"/"+rest)
		writeJSON(w, http.StatusOK, map[string]any{"accepted": true, "ref": map[string]any{
			"group": "kos.tsic.top", "kind": kind, "name": rest,
		}})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"error": map[string]any{"code": "method-not-allowed", "message": "不接受的方法", "stage": "read"},
		})
	}
}

// objectsOf returns a copy of one kind's stored objects.
func (p *controlPlane) objectsOf(kind string) []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.objects[kind]...)
}

func (p *controlPlane) writeLog() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.writes...)
}

func splitResourcePath(path string) (string, string) {
	if len(path) <= len(apiRoot) || path[:len(apiRoot)] != apiRoot {
		return "", ""
	}
	return splitOnce(path[len(apiRoot):], "/")
}

func splitOnce(value, separator string) (string, string) {
	for index := 0; index+len(separator) <= len(value); index++ {
		if value[index:index+len(separator)] == separator {
			return value[:index], value[index+len(separator):]
		}
	}
	return value, ""
}

func projectionOf(kind string, object map[string]any) map[string]any {
	return map[string]any{
		"ref":        refOf(kind, object),
		"observedAt": observedAt.Format(time.RFC3339Nano),
		"stale":      false,
		"object":     object,
	}
}

func refOf(kind string, object map[string]any) map[string]any {
	ref := map[string]any{"group": "kos.tsic.top", "kind": kind, "name": nestedString(object, "metadata", "name")}
	if namespace := nestedString(object, "metadata", "namespace"); namespace != "" {
		ref["namespace"] = namespace
	}
	return ref
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func nestedString(object map[string]any, keys ...string) string {
	value, _ := nested(object, keys...)
	text, _ := value.(string)
	return text
}

func nested(object map[string]any, keys ...string) (any, bool) {
	var current any = object
	for _, key := range keys {
		record, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = record[key]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

// pipeline reports the App contributions of the installed components. It judges
// every component the way the install path does: the artifact must resolve, the
// digest the component names must match, and the declaration must be valid.
type pipeline struct {
	artifacts map[string][]byte
}

func (p pipeline) contributions(ctx context.Context, api *client.Client) ([]apphost.Contribution, []string, error) {
	page, err := api.List(ctx, componentKind, client.ListOptions{})
	if err != nil {
		return nil, nil, fmt.Errorf("list %s: %w", componentKind, err)
	}
	var contributions []apphost.Contribution
	var refusals []string
	for _, projection := range page.Items {
		name := projection.Ref.Name
		reference := nestedString(projection.Object, "spec", "package", "reference")
		digest := nestedString(projection.Object, "spec", "package", "digest")
		archive, held := p.artifacts[reference]
		if !held {
			refusals = append(refusals, name+": artifact "+reference+" is not available")
			continue
		}
		pkg, err := packaging.Verify(archive, packaging.Digest(digest))
		if err != nil {
			refusals = append(refusals, name+": "+err.Error())
			continue
		}
		for _, app := range pkg.Manifest.Contributions.Apps {
			encoded, err := json.Marshal(app)
			if err != nil {
				return nil, nil, fmt.Errorf("report app %s: %w", app.ID, err)
			}
			contributions = append(contributions, apphost.Contribution{
				Extension: pkg.Manifest.ID,
				Component: name,
				Phase:     apphost.PhaseReady,
				Digest:    pkg.Digest.String(),
				Manifest:  encoded,
			})
		}
	}
	sort.Slice(contributions, func(left, right int) bool {
		return contributions[left].Component < contributions[right].Component
	})
	return contributions, refusals, nil
}

// component builds the install request one artifact is installed by.
func component(name, reference, digest string) map[string]any {
	return map[string]any{
		"apiVersion": "kos.tsic.top/v1beta1",
		"kind":       componentKind,
		"metadata":   map[string]any{"name": name},
		"spec": map[string]any{
			"package": map[string]any{"reference": reference, "digest": digest},
		},
	}
}

// otherPackage packs a second system application: a window with its own
// identity, installed through the same channel.
func otherPackage(t *testing.T) (packaging.Package, []byte) {
	t.Helper()
	declaration := map[string]any{
		"id":               otherExtension,
		"version":          "1.0.0",
		"frameworkVersion": ">=1.1 <2.0",
		"contributions": map[string]any{
			"apps": []any{map[string]any{
				"id":      "files",
				"name":    "文件",
				"version": "1.0.0",
				"icon":    "assets/icon.svg",
				"entry":   "https://files.apps.kos.tsic.top/index.html",
				"window": map[string]any{
					"width": 1024, "height": 720, "minWidth": 640, "minHeight": 480,
					"resizable": true, "mode": "single", "defaultState": "normal",
				},
				"permissions": []any{},
			}},
		},
		"dependencies":       map[string]any{"components": []any{map[string]any{"id": "kos-dashboard"}}},
		"permissions":        map[string]any{},
		"config":             map[string]any{},
		"status":             map[string]any{},
		"uninstallRetention": map[string]any{},
	}
	assets := []packaging.Asset{{Path: "assets/icon.svg", Content: []byte("<svg/>")}}
	pkg, archive, err := packaging.Pack(declaration, assets)
	if err != nil {
		t.Fatalf("pack the other system application: %v", err)
	}
	return pkg, archive
}

// registryOf asks the desktop's application host what it serves for the
// installed contributions and fails when the host refused any of them.
func registryOf(t *testing.T, baseURL string, pipe pipeline) *apphost.Registry {
	t.Helper()
	api, err := client.New(baseURL)
	if err != nil {
		t.Fatalf("build the control-plane client: %v", err)
	}
	contributions, refusals, err := pipe.contributions(context.Background(), api)
	if err != nil {
		t.Fatalf("read the installed contributions: %v", err)
	}
	if len(refusals) > 0 {
		t.Fatalf("install path refused components: %v", refusals)
	}
	registry := apphost.Load(contributions, apphost.ValidationOptions{ConsoleOrigin: consoleOrigin})
	if refusals := registry.Refusals(); len(refusals) > 0 {
		t.Fatalf("application host refused contributions: %+v", refusals)
	}
	return registry
}

func startPlane(t *testing.T) (*controlPlane, string) {
	t.Helper()
	plane := newControlPlane()
	server := httptest.NewServer(plane)
	t.Cleanup(server.Close)
	return plane, server.URL
}

func TestWindowAppearsOnInstallAndDisappearsOnUninstall(t *testing.T) {
	plane, baseURL := startPlane(t)
	api, err := client.New(baseURL)
	if err != nil {
		t.Fatalf("build the control-plane client: %v", err)
	}

	ourPackage, ourArchive, err := kosbackup.Package()
	if err != nil {
		t.Fatalf("pack kos-backup: %v", err)
	}
	other, otherArchive := otherPackage(t)
	pipe := pipeline{artifacts: map[string][]byte{
		"kos-backup":   ourArchive,
		otherExtension: otherArchive,
	}}

	// Both products are installed through the one install channel: a
	// SystemComponent write naming the artifact and its digest.
	mustCreate(t, api, component("files", otherExtension, other.Digest.String()), "files")
	mustCreate(t, api, component("kos-backup", kosbackup.ExtensionID, ourPackage.Digest.String()), "kos-backup")

	registry := registryOf(t, baseURL, pipe)
	entry, found := registry.App(kosbackup.AppID)
	if !found {
		t.Fatalf("installed kos-backup reports no window; host served %+v", registry.Apps())
	}

	// The window equals the declaration the package carries.
	declared := kosbackup.App()
	if entry.Name != declared.Name || entry.Version != declared.Version {
		t.Fatalf("window %q %q, want %q %q", entry.Name, entry.Version, declared.Name, declared.Version)
	}
	if entry.Entry != declared.Entry {
		t.Fatalf("window entry %q, want %q", entry.Entry, declared.Entry)
	}
	if entry.Window != (apphost.WindowDefaults{
		Width: pixels(t, declared.Window.Width), Height: pixels(t, declared.Window.Height),
		MinWidth: pixels(t, declared.Window.MinWidth), MinHeight: pixels(t, declared.Window.MinHeight),
		Resizable: declared.Window.Resizable, Mode: declared.Window.Mode,
		DefaultState: declared.Window.DefaultState,
	}) {
		t.Fatalf("window defaults %+v do not equal the declaration %+v", entry.Window, declared.Window)
	}
	if entry.Origin() != kosbackup.AppOrigin {
		t.Fatalf("window origin %q, want %q", entry.Origin(), kosbackup.AppOrigin)
	}
	if entry.Digest != ourPackage.Digest.String() {
		t.Fatalf("window digest %q, want %q", entry.Digest, ourPackage.Digest.String())
	}
	if len(registry.Apps()) != 2 {
		t.Fatalf("host serves %d applications, want the two installed products", len(registry.Apps()))
	}

	// One contribution class, one window: the declaration carries no page,
	// setting, controller or object class, so none appears (KOSD-C-18).
	if got := ourPackage.Manifest.Contributions; len(got.Pages) != 0 || len(got.Settings) != 0 ||
		len(got.Controllers) != 0 || len(got.ObjectClasses) != 0 ||
		len(got.Capabilities) != 0 || len(got.CatalogSources) != 0 ||
		len(got.DiscoveryAdapters) != 0 || len(got.DiagnosticAdapters) != 0 ||
		got.UserPreferences != nil || len(got.Apps) != 1 {
		t.Fatalf("declared contributions %+v do not match the one window the case expects", got)
	}

	// Uninstall: the same resource is deleted, the product's window goes away and
	// the other product's window stays.
	mustDelete(t, api, componentKind, "kos-backup")

	after := registryOf(t, baseURL, pipe)
	if _, found := after.App(kosbackup.AppID); found {
		t.Fatalf("uninstalled kos-backup still reports a window: %+v", after.Apps())
	}
	remaining, found := after.App("files")
	if !found {
		t.Fatalf("uninstalling kos-backup removed the other product's window")
	}
	if remaining.Digest != other.Digest.String() {
		t.Fatalf("the other product's digest changed after our uninstall: %q", remaining.Digest)
	}
	if len(after.Apps()) != 1 {
		t.Fatalf("host serves %d applications after the uninstall, want 1", len(after.Apps()))
	}

	// Kernel objects are untouched, and every write went through the one install
	// resource: no dedicated install path was used.
	applications := plane.objectsOf("Application")
	if len(applications) != 1 {
		t.Fatalf("kernel applications after install and uninstall: %d, want 1", len(applications))
	}
	before, _ := json.Marshal(axisObject())
	got, _ := json.Marshal(applications[0])
	if !bytes.Equal(before, got) {
		t.Fatalf("the kernel object changed:\n before %s\n after  %s", before, got)
	}
	wantWrites := []string{
		"create " + componentKind + "/files",
		"create " + componentKind + "/kos-backup",
		"delete " + componentKind + "/kos-backup",
	}
	if writes := plane.writeLog(); fmt.Sprint(writes) != fmt.Sprint(wantWrites) {
		t.Fatalf("writes on the control plane = %v, want %v", writes, wantWrites)
	}
}

func TestDigestMismatchKeepsTheWindowOut(t *testing.T) {
	_, baseURL := startPlane(t)
	api, err := client.New(baseURL)
	if err != nil {
		t.Fatalf("build the control-plane client: %v", err)
	}

	ourPackage, ourArchive, err := kosbackup.Package()
	if err != nil {
		t.Fatalf("pack kos-backup: %v", err)
	}
	// The component names a digest that is not the artifact's: the install must
	// be refused and no window may appear (KOSD-C-17).
	wrong := "sha256:" + fmt.Sprintf("%064d", 0)
	mustCreate(t, api, component("kos-backup", kosbackup.ExtensionID, wrong), "kos-backup")

	pipe := pipeline{artifacts: map[string][]byte{"kos-backup": ourArchive}}
	contributions, refusals, err := pipe.contributions(context.Background(), api)
	if err != nil {
		t.Fatalf("read the installed contributions: %v", err)
	}
	if len(contributions) != 0 {
		t.Fatalf("a mismatched digest produced contributions: %+v", contributions)
	}
	if len(refusals) != 1 {
		t.Fatalf("refusals = %v, want one for the mismatched digest", refusals)
	}
	registry := apphost.Load(contributions, apphost.ValidationOptions{ConsoleOrigin: consoleOrigin})
	if _, found := registry.App(kosbackup.AppID); found {
		t.Fatalf("a refused package still reports a window")
	}
	if ourPackage.Digest.String() == wrong {
		t.Fatalf("the test digest must differ from the artifact's")
	}
}

func TestPackageCarriesTheManifestAndItsAssetsAndTheDigestCoversThem(t *testing.T) {
	pkg, archive, err := kosbackup.Package()
	if err != nil {
		t.Fatalf("pack kos-backup: %v", err)
	}

	entries := archiveEntries(t, archive)
	assets, err := kosbackup.Assets()
	if err != nil {
		t.Fatalf("read the assets: %v", err)
	}
	want := []string{packaging.ManifestEntry}
	for _, asset := range assets {
		want = append(want, asset.Path)
	}
	want = append(want, packaging.DigestEntry)
	sort.Strings(want)
	got := make([]string, 0, len(entries))
	for name := range entries {
		got = append(got, name)
	}
	sort.Strings(got)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("package entries = %v, want the declared entries %v", got, want)
	}

	// The icon the manifest names is carried by the package (KOSD-C-73).
	if _, carried := entries[pkg.Manifest.Contributions.Apps[0].Icon]; !carried {
		t.Fatalf("manifest icon %q is not a package entry", pkg.Manifest.Contributions.Apps[0].Icon)
	}

	// Changing one UI asset changes the digest, and the package still verifies
	// against the new one (SDK-C-4).
	mutated := make([]packaging.Asset, 0, len(assets))
	for _, asset := range assets {
		content := append([]byte(nil), asset.Content...)
		if asset.Path == "assets/index.html" {
			content = append(content, []byte("\n<!-- 演练差异 -->\n")...)
		}
		mutated = append(mutated, packaging.Asset{Path: asset.Path, Content: content})
	}
	declaration, err := kosbackup.Declaration()
	if err != nil {
		t.Fatalf("read the declaration: %v", err)
	}
	changed, changedArchive, err := packaging.Pack(declaration, mutated)
	if err != nil {
		t.Fatalf("pack the changed assets: %v", err)
	}
	if changed.Digest == pkg.Digest {
		t.Fatalf("the digest did not change with one UI asset")
	}
	if _, err := packaging.Verify(changedArchive, changed.Digest); err != nil {
		t.Fatalf("the changed package does not verify: %v", err)
	}
	if _, err := packaging.Verify(changedArchive, pkg.Digest); err == nil {
		t.Fatalf("the old digest accepted the changed package")
	}
}

func archiveEntries(t *testing.T, archive []byte) map[string][]byte {
	t.Helper()
	decompressed, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		t.Fatalf("read the package archive: %v", err)
	}
	defer decompressed.Close()
	entries := map[string][]byte{}
	reader := tar.NewReader(decompressed)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("walk the package archive: %v", err)
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read entry %q: %v", header.Name, err)
		}
		entries[header.Name] = content
	}
	return entries
}

func mustCreate(t *testing.T, api *client.Client, object map[string]any, name string) {
	t.Helper()
	result, err := api.Create(context.Background(), componentKind, "", object)
	if err != nil {
		t.Fatalf("install %s: %v", name, err)
	}
	if !result.Accepted {
		t.Fatalf("install %s was not accepted", name)
	}
	if result.Ref == nil || result.Ref.Name != name {
		t.Fatalf("install %s answered ref %+v", name, result.Ref)
	}
}

func mustDelete(t *testing.T, api *client.Client, kind, name string) {
	t.Helper()
	result, err := api.Delete(context.Background(), kind, "", name, "")
	if err != nil {
		t.Fatalf("uninstall %s: %v", name, err)
	}
	if !result.Accepted {
		t.Fatalf("uninstall %s was not accepted", name)
	}
}

// pixels renders a declared size as the whole pixel count the host reads. A
// fractional size is a declaration error, not something to truncate.
func pixels(t *testing.T, value float64) int {
	t.Helper()
	if value != float64(int(value)) {
		t.Fatalf("window size %v is not a whole number of pixels", value)
	}
	return int(value)
}
