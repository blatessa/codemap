// Package goext is codemap's Go extractor. It loads
// every package under each go.mod in the repo with go/packages (tests included),
// builds SSA, and resolves calls with VTA so calls through interfaces reach their
// implementations. On top of the call graph it finds HTTP routes, CLI commands,
// configured jobs, subscribers and publishers, SQL queries, and calls to
// external services, and it reads migrations through sqlext.
//
// Conventions worth knowing:
//   - Closures are not nodes. A function literal's calls, queries and publishes
//     are folded into the named function that encloses it. A function literal
//     used directly as a route, command, job or subscriber handler gives that entry node
//     direct edges to whatever the literal calls. A function literal assigned to
//     a package-level variable becomes a node named after the variable.
//   - Code in _test.go files never becomes a function node and is never a callee
//     of production code. Each TestXxx becomes a test node with direct calls
//     edges to the production functions it reaches through test helpers.
//   - Calls are followed only between repo functions. Calls into dependencies
//     stop there, except calls into known external-service SDKs, which become
//     edges to ext: nodes.
package goext

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/mod/modfile"
	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"

	"github.com/blatessa/codemap/internal/extract/sqlext"
	"github.com/blatessa/codemap/internal/graph"
	"github.com/blatessa/codemap/internal/project"
)

// Logf reports problems that don't stop extraction (packages with type errors,
// for example). Replace it to silence or capture them.
var Logf = func(format string, args ...any) { fmt.Fprintf(os.Stderr, "goext: "+format+"\n", args...) }

const (
	topicsModule   = "mod:queue:topics"
	servicesModule = "mod:ext:services"
)

// Extract builds the partial graph for the Go code and SQL migrations in the
// repo at root. It has the build.Extractor signature.
func Extract(root string, cfg project.Config) (*graph.Graph, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	x := &extractor{root: root, cfg: cfg, b: newBuilder(), ext: newExtTable(cfg), migTables: map[string]bool{}, used: map[*project.CallPattern]bool{}}

	mig, err := sqlext.Migrations(root, cfg)
	if err != nil {
		return nil, err
	}
	for _, m := range mig.Modules {
		x.b.addModule(m)
	}
	for _, n := range mig.Nodes {
		x.b.addNode(n)
		x.migTables[n.ID] = true
	}

	mods, err := findModules(root, cfg)
	if err != nil {
		return nil, err
	}
	if _, err := exec.LookPath("go"); err != nil && len(mods) > 0 {
		Logf("Go is not installed, so Go code is not mapped; install Go to include it")
		mods = nil
	}
	for _, dir := range mods {
		if data, err := os.ReadFile(filepath.Join(dir, "go.mod")); err == nil {
			if mp := modfile.ModulePath(data); mp != "" {
				x.modulePaths = append(x.modulePaths, mp)
			}
		}
	}
	x.tmpl = findTemplates(root, cfg.Exclude)
	for _, dir := range mods {
		// One broken module (missing dependencies, a go.mod the go command
		// rejects) shouldn't hide the rest of the repo.
		if err := x.extractModule(dir); err != nil {
			Logf("%v", err)
		}
	}
	x.addModelColumns()
	x.addScreens()
	x.linkRequests()
	x.addFragments()
	if len(mods) > 0 {
		x.reportUnusedPatterns()
	}
	return x.b.graph(), nil
}

// reportUnusedPatterns warns about config call patterns that matched no call:
// a typo in the name, or a pattern the code doesn't use, maps nothing.
func (x *extractor) reportUnusedPatterns() {
	for _, k := range []struct {
		name string
		pats []project.CallPattern
	}{{"jobs", x.cfg.Go.Jobs}, {"subscribers", x.cfg.Go.Subscribers}, {"publishers", x.cfg.Go.Publishers}} {
		for i := range k.pats {
			if !x.used[&k.pats[i]] {
				Logf("config.toml: go.%s call %q matched no call in the code", k.name, k.pats[i].Call)
			}
		}
	}
}

type extractor struct {
	root        string
	cfg         project.Config
	b           *builder
	ext         *extTable
	modulePaths []string                      // module paths of the repo's go.mod files
	migTables   map[string]bool               // table node IDs defined by migrations
	ddl         *sqlext.Schema                // tables created by DDL in Go strings (ddl.go)
	models      []modelTable                  // ORM models' columns, applied once all tables are known
	tmpl        *templates                    // template files and their names (screens.go)
	requests    []request                     // calls to the repo's own HTTP API, matched to routes at the end (requests.go)
	fragments   []sqlFragment                 // table accesses in SQL fragments, kept at the end if the table is known (fragments.go)
	used        map[*project.CallPattern]bool // config call patterns that matched a call
}

// findModules returns the directories under root holding a go.mod, skipping
// sqlext.SkippedDirs, hidden directories and config.exclude.
func findModules(root string, cfg project.Config) ([]string, error) {
	var dirs []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if sqlext.SkipDir(rel, cfg.Exclude) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == "go.mod" {
			dirs = append(dirs, filepath.Dir(p))
		}
		return nil
	})
	sort.Strings(dirs)
	return dirs, err
}

// load is one go.mod root: its packages, SSA program and call graph.
type load struct {
	x     *extractor
	fset  *token.FileSet
	plain []*packages.Package // non-test variants of the repo's packages, sorted by path
	tests []*packages.Package // test variants (p [p.test]) and external test packages
	prog  *ssa.Program
	cg    *callgraph.Graph

	ssaPkg      map[*packages.Package]*ssa.Package
	plainSSA    map[*ssa.Package]bool
	bySyntax    map[ast.Node][]*ssa.Function
	varClosures map[*ssa.Function]string // closures assigned to package-level vars → node ID
	storedVars  map[string][]storedVar   // package → variables holding function literals in a composite literal
	pkgByTypes  map[*types.Package]*packages.Package

	// sites maps a call's Lparen position to its resolved callees (plain variants only).
	sites map[token.Pos][]*ssa.Function
	files map[string][]byte // source cache

	queryParams map[*types.Func]int // functions passing a parameter to a DB method → its index
	sqlSeen     map[sqlKey]bool     // queries already classified as DB method arguments

	reqWrappers  map[*types.Func][]reqTmpl // request helpers → their requests (requests.go)
	reqSeen      map[*types.Func]map[string]bool
	strHelpers   map[*types.Func][]rpart            // functions building a string from their parameters (requests.go)
	fieldReqs    map[*types.Func][]*fieldReq        // request builders: methods requesting a receiver field's URL (fieldreq.go)
	fieldSetters map[*types.Func]map[*types.Var]int // functions storing a parameter in such a field → its index

	ormParams  map[*types.Func][]ormWrap // ORM wrappers → the parameters naming their model
	ormIfaces  map[*types.Interface]*ormPreset
	ormTypes   map[*types.Named]*ormPreset // concrete types of the ORM packages imported
	tableNames map[*types.TypeName]string
	models     map[*types.TypeName]*ormPreset // types used as ORM models → their ORM
	ormHelpers map[*types.Func]ormModel       // session-building helpers → the model they return
	ormLocals  []ormLocal
	decls      map[*types.Func]declRef
}

const loadMode = packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes |
	packages.NeedTypesInfo | packages.NeedImports | packages.NeedModule

func (x *extractor) extractModule(dir string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("extracting %s: %v", dir, r)
		}
	}()
	pcfg := &packages.Config{Mode: loadMode, Dir: dir, Tests: true}
	pkgs, err := packages.Load(pcfg, "./...")
	if err != nil {
		return fmt.Errorf("loading %s: %w", dir, err)
	}
	l := &load{
		x:           x,
		ssaPkg:      map[*packages.Package]*ssa.Package{},
		plainSSA:    map[*ssa.Package]bool{},
		bySyntax:    map[ast.Node][]*ssa.Function{},
		varClosures: map[*ssa.Function]string{},
		storedVars:  map[string][]storedVar{},
		pkgByTypes:  map[*types.Package]*packages.Package{},
		sites:       map[token.Pos][]*ssa.Function{},
		files:       map[string][]byte{},
		queryParams: map[*types.Func]int{},
		sqlSeen:     map[sqlKey]bool{},
		reqWrappers: map[*types.Func][]reqTmpl{},
		reqSeen:     map[*types.Func]map[string]bool{},
		strHelpers:  map[*types.Func][]rpart{},
		fieldReqs:   map[*types.Func][]*fieldReq{},
		ormParams:   map[*types.Func][]ormWrap{},
		ormIfaces:   map[*types.Interface]*ormPreset{},
		tableNames:  map[*types.TypeName]string{},
		models:      map[*types.TypeName]*ormPreset{},
		ormHelpers:  map[*types.Func]ormModel{},
	}
	var initial []*packages.Package
	for _, p := range pkgs {
		for _, e := range p.Errors {
			Logf("%s: %v", p.ID, e)
		}
		if p.Types == nil || p.IllTyped || len(p.Syntax) == 0 {
			continue
		}
		if strings.HasSuffix(p.ID, ".test") && p.Name == "main" {
			continue // synthesized test main
		}
		if !x.inRepo(p) {
			continue
		}
		initial = append(initial, p)
		if p.ID == p.PkgPath {
			l.plain = append(l.plain, p)
		} else {
			l.tests = append(l.tests, p)
		}
	}
	if len(initial) == 0 {
		return nil
	}
	sort.Slice(l.plain, func(i, j int) bool { return l.plain[i].PkgPath < l.plain[j].PkgPath })
	sort.Slice(l.tests, func(i, j int) bool { return l.tests[i].ID < l.tests[j].ID })
	l.fset = initial[0].Fset
	packages.Visit(pkgs, nil, func(p *packages.Package) {
		if p.Types != nil {
			if _, ok := l.pkgByTypes[p.Types]; !ok {
				l.pkgByTypes[p.Types] = p
			}
		}
	})

	prog, ssaPkgs := ssautil.Packages(initial, ssa.InstantiateGenerics)
	for i, p := range initial {
		if ssaPkgs[i] != nil {
			l.ssaPkg[p] = ssaPkgs[i]
			if p.ID == p.PkgPath {
				l.plainSSA[ssaPkgs[i]] = true
			}
		}
	}
	prog.Build()
	l.prog = prog
	all := ssautil.AllFunctions(prog)
	for fn := range all {
		if syn := fn.Syntax(); syn != nil {
			l.bySyntax[syn] = append(l.bySyntax[syn], fn)
		}
	}
	l.cg = vta.CallGraph(all, nil)

	l.addModulesAndFunctions()
	l.addCallEdges()
	l.addTests()
	l.addGoDDL()
	l.scanCalls()
	l.collectModels()
	l.scanRenders()
	l.addRoutes()
	l.addCommands()
	l.addBackgroundJobs()
	return nil
}

// inRepo reports whether a loaded package is part of the repo: its directory is
// under the root and not skipped or excluded.
func (x *extractor) inRepo(p *packages.Package) bool {
	files := p.GoFiles
	if len(files) == 0 {
		files = p.CompiledGoFiles
	}
	if len(files) == 0 {
		return false
	}
	rel, ok := x.rel(filepath.Dir(files[0]))
	if !ok {
		return false
	}
	for d := rel; d != "." && d != "/" && d != ""; d = path.Dir(d) {
		if sqlext.SkipDir(d, x.cfg.Exclude) {
			return false
		}
	}
	return true
}

// rel returns a slash-separated path relative to the repo root.
func (x *extractor) rel(p string) (string, bool) {
	r, err := filepath.Rel(x.root, p)
	if err != nil || strings.HasPrefix(r, "..") {
		return "", false
	}
	return filepath.ToSlash(r), true
}

func (l *load) pos(p token.Pos) (string, int) {
	if !p.IsValid() {
		return "", 0
	}
	ps := l.fset.Position(p)
	rel, ok := l.x.rel(ps.Filename)
	if !ok {
		return "", 0
	}
	return rel, ps.Line
}

// fileExcluded reports whether a repo-relative file matches config.exclude.
func (l *load) fileExcluded(rel string) bool { return sqlext.Excluded(rel, l.x.cfg.Exclude) }

// ssaFor returns the SSA function for syntax in the given package variant.
func (l *load) ssaFor(syn ast.Node, p *packages.Package) *ssa.Function {
	sp := l.ssaPkg[p]
	for _, fn := range l.bySyntax[syn] {
		if fn.Pkg == sp || fn.Pkg == nil && sp == nil {
			return fn
		}
	}
	return nil
}

// top returns the named function enclosing fn (fn itself unless it's a closure),
// and the generic origin of an instantiation.
func top(fn *ssa.Function) *ssa.Function {
	for fn.Parent() != nil {
		fn = fn.Parent()
	}
	if o := fn.Origin(); o != nil {
		fn = o
	}
	return fn
}

// idOf returns the node ID fn's code belongs to: its own ID, the enclosing
// function's for closures, or a package-level variable's for closures assigned
// to one. A package initializer's code (the package-level variables'
// initialisers) belongs to the package's init node (initID). It returns "" for
// other synthetic functions (wrappers, thunks). The ID may not be a node
// (dependencies, test code, a package whose initialisers call nothing).
func (l *load) idOf(fn *ssa.Function) string {
	for f := fn; f != nil; f = f.Parent() {
		if id, ok := l.varClosures[f]; ok {
			return id
		}
	}
	t := top(fn)
	if t.Pkg != nil && t.Synthetic == "package initializer" && t.Name() == "init" {
		return initID(t.Pkg.Pkg.Path())
	}
	if t.Synthetic != "" || t.Pkg == nil {
		return ""
	}
	return graph.GoFuncID(t.Pkg.Pkg.Path(), t.RelString(t.Pkg.Pkg))
}

// funcID returns the node ID for a declared function or method object.
func (l *load) funcID(f *types.Func) string {
	if f == nil || f.Pkg() == nil {
		return ""
	}
	f = f.Origin()
	if fn := l.prog.FuncValue(f); fn != nil {
		return l.idOf(fn)
	}
	sig := f.Signature()
	if sig.Recv() == nil {
		return graph.GoFuncID(f.Pkg().Path(), f.Name())
	}
	return graph.GoFuncID(f.Pkg().Path(), "("+types.TypeString(sig.Recv().Type(), types.RelativeTo(f.Pkg()))+")."+f.Name())
}

// repoCode reports whether fn was written in a file under the repo root.
func (l *load) repoCode(fn *ssa.Function) bool {
	t := top(fn)
	if !t.Pos().IsValid() {
		return false
	}
	_, ok := l.x.rel(l.fset.Position(t.Pos()).Filename)
	return ok
}

// isTestCode reports whether fn was written in a _test.go file.
func (l *load) isTestCode(fn *ssa.Function) bool {
	t := top(fn)
	if !t.Pos().IsValid() {
		return false
	}
	return strings.HasSuffix(l.fset.Position(t.Pos()).Filename, "_test.go")
}

func (l *load) moduleID(pkgPath string) string {
	return graph.ModuleID("go", strings.TrimSuffix(pkgPath, "_test"))
}

// addModulesAndFunctions adds a module per package and a node per function and
// method declared in its non-test files.
func (l *load) addModulesAndFunctions() {
	for _, p := range l.plain {
		dir := filepath.Dir(p.GoFiles[0])
		rel, _ := l.x.rel(dir)
		label := rel
		if rel == "." {
			label = p.PkgPath
		}
		mod := graph.Module{ID: l.moduleID(p.PkgPath), Label: label, Lang: "go", Path: rel, Doc: l.packageDoc(p.Syntax)}
		l.x.b.addModule(mod)

		for _, f := range p.Syntax {
			file, _ := l.pos(f.Pos())
			if file == "" || l.fileExcluded(file) {
				continue
			}
			for _, d := range f.Decls {
				switch d := d.(type) {
				case *ast.FuncDecl:
					fn := l.ssaFor(d, p)
					if fn == nil {
						continue
					}
					id := l.idOf(fn)
					if id == "" {
						continue
					}
					_, line := l.pos(d.Pos())
					_, end := l.pos(d.End())
					l.x.b.addNode(graph.Node{
						ID: id, Kind: graph.KindFunction, Label: funcLabel(d), Module: mod.ID,
						File: file, Line: line, EndLine: end, Doc: docText(d.Doc),
						Entry: p.Name == "main" && d.Recv == nil && d.Name.Name == "main",
					})
				case *ast.GenDecl:
					l.addVarClosures(p, mod.ID, file, d)
				}
			}
		}
		l.addInitNode(p, mod.ID)
	}
}

// initID is the ID of a package's init node: the code initialising its
// package-level variables (var ormWrites = set(…)), which runs when a program
// importing the package starts. Declared init functions are "init#1" and so
// on, so the IDs don't collide.
func initID(pkgPath string) string { return graph.GoFuncID(pkgPath, "init") }

// initLabel is the label of a package's init node.
const initLabel = "init (package vars)"

// addInitNode adds a package's init node when its package-level variable
// initialisers call repo functions or external-service SDKs. Its calls edges
// come from the call graph like any function's (addCallEdges), and its code
// is scanned like a function body (eachFunc).
func (l *load) addInitNode(p *packages.Package, modID string) {
	sp := l.ssaPkg[p]
	if sp == nil {
		return
	}
	init := sp.Func("init")
	if init == nil {
		return
	}
	file, line := "", 0 // the first call site, as edges pick theirs
	var visit func(f *ssa.Function)
	visit = func(f *ssa.Function) {
		if _, ok := l.varClosures[f]; ok {
			return // a node of its own
		}
		if n := l.cg.Nodes[f]; n != nil {
			for _, e := range n.Out {
				if e.Site == nil {
					continue
				}
				pos := e.Site.Common().Pos()
				for _, t := range l.resolve(e.Callee.Func, 0) {
					useful := false
					if t.Pkg != nil && l.isRepoPkg(t.Pkg.Pkg.Path()) {
						useful = l.repoCode(t) && !l.isTestCode(t) && !strings.HasPrefix(t.Name(), "init#")
					} else if t.Pkg != nil {
						_, useful = l.x.ext.lookup(t.Pkg.Pkg.Path())
					}
					if f, ln := l.pos(pos); useful && f != "" && (file == "" || f < file || f == file && ln < line) {
						file, line = f, ln
					}
				}
			}
		}
		for _, a := range f.AnonFuncs {
			visit(a)
		}
	}
	visit(init)
	stored := l.storedVars[p.PkgPath]
	for _, v := range stored {
		if file == "" || v.file < file || v.file == file && v.line < line {
			file, line = v.file, v.line
		}
	}
	if file == "" || l.fileExcluded(file) {
		return
	}
	l.x.b.addNode(graph.Node{
		ID: initID(p.PkgPath), Kind: graph.KindFunction, Label: initLabel, Module: modID,
		File: file, Line: line, EndLine: line,
	})
	// Function literals stored in variables (a table of migrations, a
	// sync.Pool's New) are handed to whatever reads the variable, which the
	// call graph often can't see; like a function passed to a dependency
	// (callbacks.go), the code storing them calls them.
	for _, v := range stored {
		l.x.b.addEdge(graph.Edge{From: initID(p.PkgPath), To: v.id, Type: graph.Calls, File: v.file, Line: v.line})
	}
}

// storedVar is a package-level variable whose initialiser stores function
// literals in a composite literal.
type storedVar struct {
	id, file string
	line     int
}

// addVarClosures makes nodes for function literals assigned to package-level
// variables (var handler = func(...) {...}).
func (l *load) addVarClosures(p *packages.Package, modID, file string, d *ast.GenDecl) {
	if d.Tok != token.VAR {
		return
	}
	for _, s := range d.Specs {
		vs := s.(*ast.ValueSpec)
		for i, v := range vs.Values {
			if i >= len(vs.Names) || vs.Names[i].Name == "_" {
				continue
			}
			lits := []*ast.FuncLit{funcLit(v)}
			stored := lits[0] == nil
			if stored {
				lits, _ = varParts(v)
			}
			id := graph.GoFuncID(p.PkgPath, vs.Names[i].Name)
			found := false
			for _, lit := range lits {
				if fn := l.ssaFor(lit, p); fn != nil {
					l.varClosures[fn] = id
					found = true
				}
			}
			if !found {
				continue
			}
			_, line := l.pos(vs.Pos())
			_, end := l.pos(vs.End())
			doc := vs.Doc
			if doc == nil && len(d.Specs) == 1 {
				doc = d.Doc
			}
			l.x.b.addNode(graph.Node{
				ID: id, Kind: graph.KindFunction, Label: vs.Names[i].Name, Module: modID,
				File: file, Line: line, EndLine: end, Doc: docText(doc),
			})
			if stored {
				l.storedVars[p.PkgPath] = append(l.storedVars[p.PkgPath], storedVar{id, file, line})
			}
		}
	}
}

// varParts splits a package-level variable's initialiser into the function
// literals stored in it (var migrations = []func(*sql.Tx) error{func…, func…},
// var handlers = map[string]Handler{"a": {Run: func…}}), which run when the
// program calls them, and the rest, which runs in the package's init.
func varParts(e ast.Expr) (lits []*ast.FuncLit, rest []ast.Expr) {
	var walk func(e ast.Expr)
	walk = func(e ast.Expr) {
		switch v := e.(type) {
		case *ast.FuncLit:
			lits = append(lits, v)
		case *ast.CompositeLit:
			for _, el := range v.Elts {
				walk(el)
			}
		case *ast.KeyValueExpr:
			rest = append(rest, v.Key)
			walk(v.Value)
		case *ast.ParenExpr:
			walk(v.X)
		case *ast.UnaryExpr:
			if v.Op == token.AND {
				walk(v.X)
			} else {
				rest = append(rest, e)
			}
		default:
			rest = append(rest, e)
		}
	}
	walk(e)
	return lits, rest
}

// funcLit returns the function literal e is, possibly wrapped in a conversion
// such as http.HandlerFunc(func(...) {...}).
func funcLit(e ast.Expr) *ast.FuncLit {
	for {
		switch v := e.(type) {
		case *ast.FuncLit:
			return v
		case *ast.ParenExpr:
			e = v.X
		case *ast.CallExpr:
			if len(v.Args) != 1 {
				return nil
			}
			e = v.Args[0]
		default:
			return nil
		}
	}
}

// funcLabel is "Func" or "Type.Method".
func funcLabel(d *ast.FuncDecl) string {
	if d.Recv == nil || len(d.Recv.List) == 0 {
		return d.Name.Name
	}
	t := d.Recv.List[0].Type
	for {
		switch v := t.(type) {
		case *ast.StarExpr:
			t = v.X
			continue
		case *ast.ParenExpr:
			t = v.X
			continue
		case *ast.IndexExpr:
			t = v.X
			continue
		case *ast.IndexListExpr:
			t = v.X
			continue
		}
		break
	}
	if id, ok := t.(*ast.Ident); ok {
		return id.Name + "." + d.Name.Name
	}
	return d.Name.Name
}

// docText returns a doc comment as text: lines within a paragraph joined with
// spaces, paragraphs separated by a blank line.
func docText(cg *ast.CommentGroup) string {
	if cg == nil {
		return ""
	}
	var paras []string
	for p := range strings.SplitSeq(strings.TrimSpace(cg.Text()), "\n\n") {
		if p = strings.Join(strings.Fields(p), " "); p != "" {
			paras = append(paras, p)
		}
	}
	return strings.Join(paras, "\n\n")
}

// packageDoc returns the package comment, preferring doc.go.
func (l *load) packageDoc(files []*ast.File) string {
	doc := ""
	for _, f := range files {
		if f.Doc == nil {
			continue
		}
		name := filepath.Base(l.fset.Position(f.Pos()).Filename)
		if t := docText(f.Doc); t != "" && (doc == "" || name == "doc.go") {
			doc = t
		}
	}
	return doc
}

// resolve expands synthetic callees (bound-method closures, interface thunks,
// promotion and pointer wrappers, generic instances) to the functions they call.
func (l *load) resolve(fn *ssa.Function, depth int) []*ssa.Function {
	if fn == nil {
		return nil
	}
	// An instance of a generic function is a call to that function, not to
	// what it calls.
	if o := fn.Origin(); o != nil && o.Synthetic == "" {
		return []*ssa.Function{o}
	}
	switch {
	case fn.Synthetic == "" || fn.Synthetic == "from type information":
		if o := fn.Origin(); o != nil {
			return []*ssa.Function{o}
		}
		return []*ssa.Function{fn}
	case strings.HasPrefix(fn.Synthetic, "package initializer"):
		return nil
	}
	n := l.cg.Nodes[fn]
	if n == nil || len(n.Out) == 0 || depth > 4 {
		if o := fn.Origin(); o != nil {
			return []*ssa.Function{o}
		}
		return []*ssa.Function{fn}
	}
	var out []*ssa.Function
	for _, e := range n.Out {
		out = append(out, l.resolve(e.Callee.Func, depth+1)...)
	}
	return out
}

// sortedFuncs returns the call graph's functions in a stable order.
func (l *load) sortedFuncs(keep func(*ssa.Function) bool) []*ssa.Function {
	var fns []*ssa.Function
	for fn := range l.cg.Nodes {
		if fn != nil && keep(fn) {
			fns = append(fns, fn)
		}
	}
	sort.Slice(fns, func(i, j int) bool {
		a, b := fns[i], fns[j]
		if a.Pos() != b.Pos() {
			return a.Pos() < b.Pos()
		}
		return a.String() < b.String()
	})
	return fns
}

// addCallEdges adds calls edges between repo functions from the VTA call graph
// of the non-test package variants, and records resolved callees per call site.
func (l *load) addCallEdges() {
	fns := l.sortedFuncs(func(fn *ssa.Function) bool { return l.plainSSA[fn.Pkg] })
	cb := l.findCallbacks(fns)
	for _, fn := range fns {
		from := l.idOf(fn)
		if l.x.b.has(from) {
			for _, pf := range cb.passed(fn) {
				file, line := l.pos(pf.site.Common().Pos())
				for _, t := range l.resolve(pf.fn, 0) {
					if to := l.idOf(t); to != "" && to != from && l.repoCode(t) && !l.isTestCode(t) {
						l.x.b.addEdge(graph.Edge{From: from, To: to, Type: graph.Calls, File: file, Line: line})
					}
				}
			}
		}
		for _, e := range l.cg.Nodes[fn].Out {
			var site token.Pos
			if e.Site != nil {
				site = e.Site.Common().Pos()
			}
			targets := l.resolve(e.Callee.Func, 0)
			if site.IsValid() {
				l.sites[site] = append(l.sites[site], targets...)
			}
			if !l.x.b.has(from) || e.Site != nil && cb.skip[e.Site] {
				continue
			}
			for _, t := range targets {
				// Targets may be in another go.mod root that hasn't been loaded yet, so
				// they aren't required to be nodes here; the builder drops edges to
				// IDs that never become nodes.
				to := l.idOf(t)
				if to == "" || !l.repoCode(t) || l.isTestCode(t) {
					continue
				}
				if t.Parent() == nil && strings.HasPrefix(t.Name(), "init#") {
					continue // the package initializer running declared inits: see roles' reachability
				}
				file, line := l.pos(site)
				l.x.b.addEdge(graph.Edge{From: from, To: to, Type: graph.Calls, File: file, Line: line})
			}
		}
	}
}

// closureCallees returns the repo functions a function literal (and the
// literals nested in it) calls. Calls through captured variables declared at
// the positions in skip are left out: the caller resolves those itself (a
// route helper's handler parameter, bound to what its call site passes).
func (l *load) closureCallees(lit *ast.FuncLit, p *packages.Package, skip map[token.Pos]bool) []string {
	fn := l.ssaFor(lit, p)
	if fn == nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	var visit func(f *ssa.Function)
	visit = func(f *ssa.Function) {
		if n := l.cg.Nodes[f]; n != nil {
			for _, e := range n.Out {
				if len(skip) > 0 && e.Site != nil && skip[capturedPos(e.Site.Common().Value)] {
					continue
				}
				for _, t := range l.resolve(e.Callee.Func, 0) {
					if id := l.idOf(t); id != "" && l.x.b.has(id) && !l.isTestCode(t) && !seen[id] {
						seen[id] = true
						out = append(out, id)
					}
				}
			}
		}
		for _, a := range f.AnonFuncs {
			visit(a)
		}
	}
	visit(fn)
	return out
}

// capturedPos returns the declaration position of the captured variable a
// dynamic call goes through, or token.NoPos.
func capturedPos(v ssa.Value) token.Pos {
	if u, ok := v.(*ssa.UnOp); ok && u.Op == token.MUL {
		v = u.X // a captured variable that's assigned to is a cell
	}
	if fv, ok := v.(*ssa.FreeVar); ok {
		return fv.Pos()
	}
	return token.NoPos
}

// addTests adds a test node per TestXxx with direct calls edges to the
// production functions it reaches, walking through test helpers, fakes and
// closures in _test.go files.
func (l *load) addTests() {
	for _, p := range l.tests {
		for _, f := range p.Syntax {
			file, _ := l.pos(f.Pos())
			if !strings.HasSuffix(file, "_test.go") || l.fileExcluded(file) {
				continue
			}
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Recv != nil || !isTestName(fd.Name.Name) {
					continue
				}
				fn := l.ssaFor(fd, p)
				if fn == nil {
					continue
				}
				modID := l.moduleID(p.PkgPath)
				if _, ok := l.x.b.modules[modID]; !ok {
					rel, _ := l.x.rel(filepath.Dir(l.fset.Position(f.Pos()).Filename))
					l.x.b.addModule(graph.Module{ID: modID, Label: rel, Lang: "go", Path: rel})
				}
				id := graph.TestID("go", p.PkgPath+"."+fd.Name.Name)
				_, line := l.pos(fd.Pos())
				_, end := l.pos(fd.End())
				l.x.b.addNode(graph.Node{
					ID: id, Kind: graph.KindTest, Label: fd.Name.Name, Module: modID,
					File: file, Line: line, EndLine: end, Doc: docText(fd.Doc),
				})
				for _, to := range l.testReach(fn) {
					l.x.b.addEdge(graph.Edge{From: id, To: to, Type: graph.Calls})
				}
			}
		}
	}
}

func isTestName(name string) bool {
	rest, ok := strings.CutPrefix(name, "Test")
	if !ok {
		return false
	}
	return rest == "" || !(rest[0] >= 'a' && rest[0] <= 'z')
}

// testReach returns the production functions reached from a test function
// through test-only code.
func (l *load) testReach(start *ssa.Function) []string {
	var out []string
	found := map[string]bool{}
	seen := map[*ssa.Function]bool{}
	var queue []*ssa.Function
	push := func(f *ssa.Function) {
		var add func(*ssa.Function)
		add = func(f *ssa.Function) {
			if seen[f] {
				return
			}
			seen[f] = true
			queue = append(queue, f)
			for _, a := range f.AnonFuncs {
				add(a)
			}
		}
		add(f)
	}
	push(start)
	for len(queue) > 0 {
		fn := queue[0]
		queue = queue[1:]
		n := l.cg.Nodes[fn]
		if n == nil {
			continue
		}
		for _, e := range n.Out {
			for _, t := range l.resolve(e.Callee.Func, 0) {
				if l.isTestCode(t) {
					push(t)
					continue
				}
				if id := l.idOf(t); id != "" && l.repoCode(t) && !found[id] {
					found[id] = true
					out = append(out, id)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}
