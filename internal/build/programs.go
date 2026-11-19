package build

import (
	"encoding/json"
	"path"
	"regexp"
	"strings"

	"github.com/blatessa/codemap/internal/graph"
)

// manifests mark a program's root: the folder a server, web app or CLI is
// built from. Each names the program, or the folder does.
var manifests = []struct {
	file string
	name func(b []byte) string
}{
	{"go.mod", func(b []byte) string {
		if m := goModule.FindSubmatch(b); m != nil {
			return path.Base(string(m[1]))
		}
		return ""
	}},
	{"package.json", func(b []byte) string {
		var p struct{ Name string }
		if json.Unmarshal(b, &p) == nil && p.Name != "" {
			return strings.TrimPrefix(path.Base(p.Name), "@")
		}
		return ""
	}},
	{"Cargo.toml", tomlName},
	{"pyproject.toml", tomlName},
}

var (
	goModule = regexp.MustCompile(`(?m)^module\s+"?([^\s"]+)`)
	nameLine = regexp.MustCompile(`(?m)^name\s*=\s*"([^"]+)"`)
)

func tomlName(b []byte) string {
	if m := nameLine.FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return ""
}

// Programs sets each code module's Program: the nearest folder at or above it
// holding a build manifest (go.mod, package.json, Cargo.toml, pyproject.toml),
// named by the manifest or, without a name, by the folder. Two programs with
// the same name are told apart by their folders. read reads a repo file.
func Programs(g *graph.Graph, read func(file string) ([]byte, error)) {
	type prog struct{ dir, name string }
	found := map[string]*prog{} // folder → its program, nil when it has none
	var root func(dir string) *prog
	root = func(dir string) *prog {
		if p, ok := found[dir]; ok {
			return p
		}
		var p *prog
		for _, m := range manifests {
			b, err := read(path.Join(dir, m.file))
			if err != nil {
				continue
			}
			p = &prog{dir: dir, name: m.name(b)}
			if p.name == "" {
				p.name = path.Base(dir)
			}
			break
		}
		if p == nil && dir != "." {
			p = root(path.Dir(dir))
		}
		found[dir] = p
		return p
	}
	byName := map[string]map[string]bool{}
	of := map[int]*prog{}
	for i, m := range g.Modules {
		if m.External || m.Path == "" {
			continue
		}
		if p := root(path.Clean(m.Path)); p != nil {
			of[i] = p
			if byName[p.name] == nil {
				byName[p.name] = map[string]bool{}
			}
			byName[p.name][p.dir] = true
		}
	}
	for i, p := range of {
		name := p.name
		if len(byName[name]) > 1 {
			name = p.dir
		}
		g.Modules[i].Program = name
	}
}
