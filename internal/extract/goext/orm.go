package goext

import (
	"go/ast"
	"go/constant"
	"go/types"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"

	"github.com/blatessa/codemap/internal/extract/sqlext"
	"github.com/blatessa/codemap/internal/graph"
)

// ORM calls: reads and writes made through an ORM rather than SQL strings.
//
// A call chain like db.Where(…).Find(&users) or db.NewInsert().Model(&u).Exec(ctx)
// is an ORM call when one of its calls goes into a known ORM package. Whether it
// reads or writes comes from the method names in the chain; the table comes from
// the Go type of the model passed in it (its TableName method, a table tag, or
// the ORM's naming convention). When the model is a parameter of the enclosing
// function (Insert(ctx, beans ...any)) or one of its type parameters
// (GetByID[T any]), that function is a wrapper and the access belongs to each
// caller, with the model it passes.

type ormPreset struct {
	name   string
	pkgs   []string // import path prefixes
	plural bool     // default table names are plural ("users") rather than singular ("user")
}

var ormPresets = []*ormPreset{
	{"xorm", []string{"xorm.io/xorm", "github.com/go-xorm/xorm"}, false},
	{"gorm", []string{"gorm.io/gorm", "github.com/jinzhu/gorm"}, true},
	{"bun", []string{"github.com/uptrace/bun"}, true},
	{"go-pg", []string{"github.com/go-pg/pg"}, true},
}

func ormFor(path string) *ormPreset {
	for _, p := range ormPresets {
		for _, pre := range p.pkgs {
			if path == pre || strings.HasPrefix(path, pre+"/") {
				return p
			}
		}
	}
	return nil
}

var (
	ormWrites = set("Insert", "InsertOne", "InsertMulti", "Create", "CreateInBatches", "FirstOrCreate",
		"Save", "Update", "Updates", "UpdateColumn", "UpdateColumns", "Delete", "Upsert",
		"NewInsert", "NewUpdate", "NewDelete", "NewMerge")
	ormReads = set("Get", "Find", "First", "Last", "Take", "Count", "Exist", "Exists", "Iterate", "Rows",
		"Scan", "Pluck", "Sum", "Sums", "SumInt", "SumsInt", "FindAndCount", "ScanAndCount", "NewSelect")
	// ormRawSQL are chain methods taking a SQL string; DefaultDBMethods has them.
	ormRawSQL = set("SQL", "Raw")
	// ormModelArgs are methods whose argument names the model for the whole chain.
	ormModelArgs = set("Model", "Table")
)

func set(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		m[n] = true
	}
	return m
}

func methodName(call *ast.CallExpr) string {
	if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok {
		return sel.Sel.Name
	}
	return ""
}

// ormWrap is a wrapper's model: one of its parameters, or a type parameter.
type ormWrap struct {
	param, tparam int // -1 when unused
	variadic      bool
	table         bool // param is a table name: Table(name)
	write         bool
	orm           *ormPreset
}

// ormModel is what a model expression resolves to.
type ormModel struct {
	tables []string
	local  []*types.Named // types declared in a function: models only if their table exists
	wrap   *ormWrap       // the enclosing function's parameter or type parameter
}

func (m ormModel) empty() bool { return m.wrap == nil && len(m.tables) == 0 && len(m.local) == 0 }

func (m *ormModel) add(o ormModel) {
	m.tables = append(m.tables, o.tables...)
	m.local = append(m.local, o.local...)
}

// ormLocal is an access through a type declared in a function, kept until all
// tables are known (migrations declare local copies of the tables they change;
// other local types are query result rows).
type ormLocal struct {
	from         string
	typ          *types.Named
	orm          *ormPreset
	write        bool
	detail, file string
	line         int
}

// ormCall handles a call in a function body if it ends an ORM chain. done
// collects the inner calls of chains already handled.
func (l *load) ormCall(c *fnCtx, call *ast.CallExpr, done map[*ast.CallExpr]bool, file string, line int) {
	if done[call] {
		return
	}
	name := methodName(call)
	if !ormWrites[name] && !ormReads[name] && name != "Exec" {
		return
	}
	chain := l.chain(c, call)
	for _, k := range chain[1:] {
		done[k] = true
	}
	write, read := false, false
	var orm *ormPreset
	for _, k := range chain {
		n := methodName(k)
		if ormRawSQL[n] {
			return // SQL(…)/Raw(…): the query string says what it touches (scan.go)
		}
		write = write || ormWrites[n]
		read = read || ormReads[n]
		if orm == nil {
			orm = l.ormOf(c, k)
		}
	}
	if orm == nil || !write && !read {
		return
	}
	m := l.chainModel(c, chain, orm)
	l.ormAccess(c, m, write, orm, l.callText(call), file, line)
}

// ormAccess adds edges for a resolved model, or records the enclosing function
// as a wrapper when the model is one of its parameters.
func (l *load) ormAccess(c *fnCtx, m ormModel, write bool, orm *ormPreset, detail, file string, line int) {
	if m.wrap != nil {
		if c.fn == nil {
			return
		}
		w := *m.wrap
		w.write, w.orm = write, orm
		f := c.fn.Origin()
		for _, o := range l.ormParams[f] {
			if o == w {
				return
			}
		}
		l.ormParams[f] = append(l.ormParams[f], w)
		return
	}
	typ := graph.Reads
	if write {
		typ = graph.Writes
	}
	for _, t := range m.tables {
		id := sqlext.TableID(t)
		l.ensureTable(id, t)
		l.x.b.addEdge(graph.Edge{From: c.id, To: id, Type: typ, Detail: detail, File: file, Line: line})
	}
	for _, n := range m.local {
		l.ormLocals = append(l.ormLocals, ormLocal{c.id, n, orm, write, detail, file, line})
	}
}

// ormLocalAccesses adds the accesses through local types whose table exists.
func (l *load) ormLocalAccesses() {
	for _, a := range l.ormLocals {
		for _, t := range tableCandidates(a.typ, a.orm) {
			if id := sqlext.TableID(t); l.x.b.has(id) {
				typ := graph.Reads
				if a.write {
					typ = graph.Writes
				}
				l.x.b.addEdge(graph.Edge{From: a.from, To: id, Type: typ, Detail: a.detail, File: a.file, Line: a.line})
				break
			}
		}
	}
	l.ormLocals = nil
}

// chain returns call and the calls its receiver is built from, outermost
// first, following local variables (sess := db.Where(…); sess.Find(&x)).
func (l *load) chain(c *fnCtx, call *ast.CallExpr) []*ast.CallExpr {
	out := []*ast.CallExpr{call}
	seen := map[ast.Expr]bool{}
	x := call
	for len(out) < 32 {
		sel, ok := ast.Unparen(x.Fun).(*ast.SelectorExpr)
		if !ok {
			break
		}
		recv := ast.Unparen(sel.X)
		if id, ok := recv.(*ast.Ident); ok {
			if e := c.exprs[c.p.TypesInfo.Uses[id]]; e != nil && !seen[e] {
				seen[e] = true
				recv = ast.Unparen(e)
			}
		}
		next, ok := recv.(*ast.CallExpr)
		if !ok {
			break
		}
		out = append(out, next)
		x = next
	}
	return out
}

// ormOf returns the ORM a call goes into: by its static callee, what VTA
// resolved at the site, the type it returns, or (for a call through the
// repo's own interface) an ORM type implementing that interface.
func (l *load) ormOf(c *fnCtx, call *ast.CallExpr) *ormPreset {
	info := c.p.TypesInfo
	callee := staticCallee(info, call)
	if callee != nil && callee.Pkg() != nil {
		if o := ormFor(callee.Pkg().Path()); o != nil {
			return o
		}
	}
	for _, fn := range l.sites[call.Lparen] {
		if f, ok := fn.Object().(*types.Func); ok && f.Pkg() != nil {
			if o := ormFor(f.Pkg().Path()); o != nil {
				return o
			}
		}
	}
	if o := ormOfType(info.TypeOf(call)); o != nil {
		return o
	}
	if callee != nil {
		if r := callee.Signature().Recv(); r != nil {
			if it, ok := r.Type().Underlying().(*types.Interface); ok {
				return l.ormImplementing(it)
			}
		}
	}
	return nil
}

func ormOfType(t types.Type) *ormPreset {
	if t == nil {
		return nil
	}
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	if n, ok := types.Unalias(t).(*types.Named); ok && n.Obj().Pkg() != nil {
		return ormFor(n.Obj().Pkg().Path())
	}
	return nil
}

// ormImplementing returns the ORM one of whose types implements it.
func (l *load) ormImplementing(it *types.Interface) *ormPreset {
	if o, ok := l.ormIfaces[it]; ok {
		return o
	}
	if l.ormTypes == nil {
		l.ormTypes = map[*types.Named]*ormPreset{}
		seen := map[*types.Package]bool{}
		var walk func(p *types.Package)
		walk = func(p *types.Package) {
			if seen[p] {
				return
			}
			seen[p] = true
			if o := ormFor(p.Path()); o != nil {
				for _, n := range p.Scope().Names() {
					if tn, ok := p.Scope().Lookup(n).(*types.TypeName); ok {
						if nt, ok := tn.Type().(*types.Named); ok && !types.IsInterface(nt) {
							l.ormTypes[nt] = o
						}
					}
				}
			}
			for _, i := range p.Imports() {
				walk(i)
			}
		}
		for _, p := range l.plain {
			walk(p.Types)
		}
	}
	var found *ormPreset
	if it.NumMethods() > 0 {
		for t, o := range l.ormTypes {
			if types.Implements(types.NewPointer(t), it) {
				found = o
				break
			}
		}
	}
	l.ormIfaces[it] = found
	return found
}

// chainModel finds the model a chain works on: a Model/Table argument first,
// then the arguments of the outermost call, then any other argument.
func (l *load) chainModel(c *fnCtx, chain []*ast.CallExpr, orm *ormPreset) ormModel {
	try := func(k *ast.CallExpr) ormModel {
		var out ormModel
		// Only methods: the chain's root (db.GetEngine(ctx)) takes other things.
		sel, ok := ast.Unparen(k.Fun).(*ast.SelectorExpr)
		if s, isSel := c.p.TypesInfo.Selections[sel]; !ok || !isSel || s.Kind() != types.MethodVal {
			return out
		}
		named := ormModelArgs[methodName(k)]
		for i, a := range k.Args {
			if s, ok := c.stringValue(a); ok {
				if t := cleanTable(s); named && t != "" {
					out.tables = append(out.tables, t)
				}
				continue
			}
			if isString(c.p.TypesInfo, a) {
				if p := c.paramIndex(a); named && p >= 0 {
					return ormModel{wrap: &ormWrap{param: p, tparam: -1, table: true}}
				}
				continue
			}
			m := l.modelOf(c, a, i == len(k.Args)-1 && k.Ellipsis.IsValid(), orm)
			if m.wrap != nil {
				return m
			}
			out.add(m)
		}
		return out
	}
	for _, k := range chain {
		if ormModelArgs[methodName(k)] {
			if m := try(k); !m.empty() {
				return m
			}
		}
	}
	for _, k := range chain {
		if m := try(k); !m.empty() {
			return m
		}
	}
	// The session came from one of the repo's own helpers
	// (makeQuery(ctx).Count()): the model is in what it returns.
	if root := staticCallee(c.p.TypesInfo, chain[len(chain)-1]); root != nil && root.Pkg() != nil && l.isRepoPkg(root.Pkg().Path()) {
		return l.helperModel(root.Origin(), orm)
	}
	return ormModel{}
}

// helperModel is the model of the ORM chains a repo function returns.
func (l *load) helperModel(f *types.Func, orm *ormPreset) ormModel {
	if m, ok := l.ormHelpers[f]; ok {
		return m
	}
	l.ormHelpers[f] = ormModel{} // a helper calling itself
	var out ormModel
	if p, d := l.declOf(f); d != nil {
		hc := newFnCtx(p, "", "", f, d.Type, d.Body)
		ast.Inspect(d.Body, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.FuncLit:
				return false
			case *ast.ReturnStmt:
				for _, r := range n.Results {
					r = ast.Unparen(r)
					if id, ok := r.(*ast.Ident); ok {
						if e := hc.exprs[p.TypesInfo.Uses[id]]; e != nil {
							r = ast.Unparen(e)
						}
					}
					if call, ok := r.(*ast.CallExpr); ok {
						if m := l.chainModel(hc, l.chain(hc, call), orm); m.wrap == nil {
							out.add(m)
						}
					}
				}
			}
			return true
		})
	}
	l.ormHelpers[f] = out
	return out
}

// declOf finds a repo function's declaration.
func (l *load) declOf(f *types.Func) (*packages.Package, *ast.FuncDecl) {
	if l.decls == nil {
		l.decls = map[*types.Func]declRef{}
		for _, p := range l.plain {
			for _, file := range p.Syntax {
				for _, d := range file.Decls {
					if fd, ok := d.(*ast.FuncDecl); ok && fd.Body != nil {
						if obj, ok := p.TypesInfo.Defs[fd.Name].(*types.Func); ok {
							l.decls[obj] = declRef{fd, p}
						}
					}
				}
			}
		}
	}
	r := l.decls[f]
	return r.p, r.decl
}

// modelOf resolves a model argument. spread is true for args... passing a
// variadic parameter on.
func (l *load) modelOf(c *fnCtx, e ast.Expr, spread bool, orm *ormPreset) ormModel {
	info := c.p.TypesInfo
	t := info.TypeOf(e)
	if t == nil {
		return ormModel{}
	}
	if types.IsInterface(t) || spread {
		// A bean parameter is any; context.Context or a condition interface isn't one.
		if it, ok := t.Underlying().(*types.Interface); ok && it.NumMethods() > 0 {
			return ormModel{}
		}
		if i := c.paramIndex(e); i >= 0 {
			return ormModel{wrap: &ormWrap{param: i, tparam: -1, variadic: spread}}
		}
		if id, ok := ast.Unparen(e).(*ast.Ident); ok {
			if v := c.exprs[info.Uses[id]]; v != nil && v != e && !types.IsInterface(info.TypeOf(v)) {
				return l.modelOf(c, v, false, orm)
			}
		}
		if spread {
			if s, ok := t.Underlying().(*types.Slice); ok {
				return l.modelOfType(c, s.Elem(), orm)
			}
		}
		return ormModel{}
	}
	return l.modelOfType(c, t, orm)
}

// modelOfType finds the repo struct type in a model's type (through pointers,
// slices, arrays, maps and named lists) and its table.
func (l *load) modelOfType(c *fnCtx, t types.Type, orm *ormPreset) ormModel {
	for range 8 {
		switch u := types.Unalias(t).(type) {
		case *types.Pointer:
			t = u.Elem()
		case *types.Slice:
			t = u.Elem()
		case *types.Array:
			t = u.Elem()
		case *types.Map:
			t = u.Elem()
		case *types.TypeParam:
			if c.fn != nil {
				tps := c.fn.Origin().Signature().TypeParams()
				for i := range tps.Len() {
					if tps.At(i).Obj() == u.Obj() {
						return ormModel{wrap: &ormWrap{param: -1, tparam: i}}
					}
				}
			}
			return ormModel{}
		case *types.Named:
			if _, ok := u.Underlying().(*types.Struct); !ok {
				t = u.Underlying()
				continue
			}
			obj := u.Obj()
			if obj.Pkg() == nil || !l.isRepoPkg(obj.Pkg().Path()) {
				return ormModel{}
			}
			if obj.Parent() != obj.Pkg().Scope() {
				if s := l.declaredTable(u); s != "" {
					return ormModel{tables: []string{s}}
				}
				return ormModel{local: []*types.Named{u}}
			}
			return ormModel{tables: []string{l.tableName(u, orm)}}
		default:
			return ormModel{}
		}
	}
	return ormModel{}
}

// tableName is a model type's table: what its TableName method returns, a
// bun/go-pg table tag, or the ORM's naming convention (preferring a name a
// migration already defined).
func (l *load) tableName(n *types.Named, orm *ormPreset) string {
	n = n.Origin()
	if s, ok := l.tableNames[n.Obj()]; ok {
		return s
	}
	s := l.declaredTable(n)
	if s == "" {
		cands := tableCandidates(n, orm)
		s = cands[0]
		for _, c := range cands {
			if l.x.b.has(sqlext.TableID(c)) {
				s = c
				break
			}
		}
	}
	l.tableNames[n.Obj()] = s
	l.models[n.Obj()] = orm
	return s
}

// tableCandidates are the names an ORM's convention gives a type's table, the
// ORM's default first.
func tableCandidates(n *types.Named, orm *ormPreset) []string {
	snake := snakeCase(n.Obj().Name())
	if orm.plural {
		return []string{plural(snake), snake}
	}
	return []string{snake, plural(snake)}
}

func (l *load) declaredTable(n *types.Named) string {
	ms := types.NewMethodSet(types.NewPointer(n))
	if sel := ms.Lookup(n.Obj().Pkg(), "TableName"); sel != nil {
		if f, ok := sel.Obj().(*types.Func); ok {
			if s := constReturn(l.prog.FuncValue(f)); s != "" {
				return s
			}
		}
	}
	st := n.Underlying().(*types.Struct)
	for i := range st.NumFields() {
		tag := reflect.StructTag(st.Tag(i))
		if v, ok := strings.CutPrefix(tag.Get("bun"), "table:"); ok {
			name, _, _ := strings.Cut(v, ",")
			return name
		}
		if st.Field(i).Name() == "tableName" {
			for _, k := range []string{"pg", "sql"} {
				if name, _, _ := strings.Cut(tag.Get(k), ","); name != "" {
					return strings.Trim(name, `"`)
				}
			}
		}
	}
	return ""
}

// constReturn returns the constant string a function always returns.
func constReturn(fn *ssa.Function) string {
	if fn == nil {
		return ""
	}
	out := ""
	for _, b := range fn.Blocks {
		for _, in := range b.Instrs {
			r, ok := in.(*ssa.Return)
			if !ok || len(r.Results) != 1 {
				continue
			}
			k, ok := r.Results[0].(*ssa.Const)
			if !ok || k.Value == nil || k.Value.Kind() != constant.String {
				return ""
			}
			s := constant.StringVal(k.Value)
			if out != "" && out != s {
				return ""
			}
			out = s
		}
	}
	return out
}

// snakeCase converts a Go name to snake case, keeping initialisms together:
// HTTPServer → http_server, OAuth2Token → o_auth2_token.
func snakeCase(s string) string {
	r := []rune(s)
	var b strings.Builder
	for i, c := range r {
		if unicode.IsUpper(c) && i > 0 {
			prev := r[i-1]
			nextLower := i+1 < len(r) && unicode.IsLower(r[i+1])
			if unicode.IsLower(prev) || unicode.IsDigit(prev) || unicode.IsUpper(prev) && nextLower {
				b.WriteByte('_')
			}
		}
		b.WriteRune(unicode.ToLower(c))
	}
	return b.String()
}

// cleanTable is the table in a Table("…") argument, without quoting or an
// alias: "`user`" → user, "issue i" → issue.
func cleanTable(s string) string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return strings.Trim(f[0], "`\"[]")
}

func plural(s string) string {
	switch {
	case strings.HasSuffix(s, "y") && len(s) > 1 && !strings.ContainsRune("aeiou", rune(s[len(s)-2])):
		return s[:len(s)-1] + "ies"
	case strings.HasSuffix(s, "s"), strings.HasSuffix(s, "x"), strings.HasSuffix(s, "z"),
		strings.HasSuffix(s, "ch"), strings.HasSuffix(s, "sh"):
		return s + "es"
	}
	return s + "s"
}

// callText is a call's source on one line, shortened.
func (l *load) callText(call *ast.CallExpr) string {
	s := strings.Join(strings.Fields(l.source(call)), " ")
	if r := []rune(s); len(r) > 100 {
		s = string(r[:99]) + "…"
	}
	return s
}

// ormWrappers attributes accesses made through wrappers to their callers,
// following chains of wrappers a few levels deep.
func (l *load) ormWrappers() {
	done := map[*types.Func]int{}
	for round := 0; round < 4; round++ {
		todo := map[*types.Func]bool{}
		for f, ws := range l.ormParams {
			if done[f] < len(ws) {
				todo[f] = true
				done[f] = len(ws)
			}
		}
		if len(todo) == 0 {
			return
		}
		l.eachFunc(func(c *fnCtx, body ast.Node) {
			if !l.x.b.has(c.id) {
				return
			}
			info := c.p.TypesInfo
			ast.Inspect(body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				callee := staticCallee(info, call)
				if callee == nil || !todo[callee.Origin()] {
					return true
				}
				file, line := l.pos(call.Pos())
				for _, w := range l.ormParams[callee.Origin()] {
					var m ormModel
					switch {
					case w.tparam >= 0:
						inst, ok := info.Instances[calleeIdent(call)]
						if !ok || w.tparam >= inst.TypeArgs.Len() {
							continue
						}
						m = l.modelOfType(c, inst.TypeArgs.At(w.tparam), w.orm)
					case w.table && w.param < len(call.Args):
						a := call.Args[w.param]
						if s, ok := c.stringValue(a); ok && cleanTable(s) != "" {
							m.tables = []string{cleanTable(s)}
						} else if p := c.paramIndex(a); p >= 0 {
							m.wrap = &ormWrap{param: p, tparam: -1, table: true}
						}
					case w.param < len(call.Args):
						args := call.Args[w.param : w.param+1]
						if w.variadic && !call.Ellipsis.IsValid() {
							args = call.Args[w.param:]
						}
						for _, a := range args {
							am := l.modelOf(c, a, w.variadic && call.Ellipsis.IsValid(), w.orm)
							if am.wrap != nil {
								m = am
								break
							}
							m.add(am)
						}
					}
					l.ormAccess(c, m, w.write, w.orm, l.callText(call), file, line)
				}
				return true
			})
		})
	}
}

func calleeIdent(call *ast.CallExpr) *ast.Ident {
	fun := ast.Unparen(call.Fun)
	if ix, ok := fun.(*ast.IndexExpr); ok {
		fun = ix.X
	} else if ix, ok := fun.(*ast.IndexListExpr); ok {
		fun = ix.X
	}
	switch f := fun.(type) {
	case *ast.Ident:
		return f
	case *ast.SelectorExpr:
		return f.Sel
	}
	return nil
}

// Model columns: a table no migration or DDL describes gets its columns from
// the struct types used as its ORM models. Each exported field is a column
// (embedded structs are flattened), named by its ORM tag or the ORM's naming
// convention. Relationships come from naming: RepoID points at the table of
// the model a Repo field holds when the struct has one (Repo *Repository,
// usually tagged "-"), else at a table named repo or repos, else at the table
// other models' Repo fields point at (repo → repository); a field holding
// another model (gorm and bun relations) points at that model's table. Which
// tables exist is only known once every module is scanned, so the candidates
// are kept and resolved in addModelColumns.

// modelCol is a column of a model, with the tables it may refer to.
type modelCol struct {
	goName, name, typ, note string
	prefix                  string   // XxxID: Xxx
	paired                  []string // XxxID: table candidates of the model an Xxx field holds
	refs                    []string // XxxID: tables named after Xxx, the ORM's default first
	rel                     []string // a field holding another model: that model's table candidates
}

type modelTable struct {
	table, file string
	cols        []modelCol
}

// collectModels records the columns of the types this module used as ORM models.
func (l *load) collectModels() {
	objs := make([]*types.TypeName, 0, len(l.models))
	for o := range l.models {
		objs = append(objs, o)
	}
	sort.Slice(objs, func(i, j int) bool {
		if objs[i].Pkg().Path() != objs[j].Pkg().Path() {
			return objs[i].Pkg().Path() < objs[j].Pkg().Path()
		}
		return objs[i].Name() < objs[j].Name()
	})
	for _, o := range objs {
		file, _ := l.pos(o.Pos())
		cols := l.modelColumns(o.Type().(*types.Named), l.models[o])
		l.x.models = append(l.x.models, modelTable{l.tableNames[o], file, cols})
	}
}

// modelColumns lists a model struct's columns.
func (l *load) modelColumns(n *types.Named, orm *ormPreset) []modelCol {
	pkg := n.Obj().Pkg()
	qual := func(p *types.Package) string {
		if p == pkg {
			return ""
		}
		return p.Name()
	}
	var cols []modelCol
	seen := map[string]bool{}
	ints := map[string]bool{}     // Go names of integer fields
	held := map[string][]string{} // Go field name → table candidates of the model it holds
	var walk func(st *types.Struct, depth int)
	walk = func(st *types.Struct, depth int) {
		for i := range st.NumFields() {
			f := st.Field(i)
			tag := reflect.StructTag(st.Tag(i))
			// Recorded before the tag check: Repo *Repository `xorm:"-"` is
			// what names RepoID's table.
			rel := l.modelTables(f.Type(), orm)
			if rel != nil {
				held[f.Name()] = rel
			}
			if ormSkipped(tag) {
				continue
			}
			if f.Embedded() || slices.Contains(strings.Fields(tag.Get("xorm")), "extends") {
				if isBunBaseModel(f.Type()) {
					continue
				}
				if inner := structOf(f.Type()); inner != nil && depth < 4 {
					walk(inner, depth+1)
					continue
				}
			}
			if !f.Exported() {
				continue
			}
			switch f.Type().Underlying().(type) {
			case *types.Signature, *types.Chan:
				continue
			}
			c := modelCol{goName: f.Name(), name: ormColumnName(tag, f.Name()), typ: types.TypeString(f.Type(), qual), rel: rel}
			if seen[c.name] {
				continue
			}
			seen[c.name] = true
			if b, ok := f.Type().Underlying().(*types.Basic); ok && b.Info()&types.IsInteger != 0 {
				ints[f.Name()] = true
			}
			if ormPK(tag) {
				c.note = "pk"
			}
			cols = append(cols, c)
		}
	}
	walk(n.Underlying().(*types.Struct), 0)

	hasPK := slices.ContainsFunc(cols, func(c modelCol) bool { return c.note == "pk" })
	for i := range cols {
		c := &cols[i]
		if c.goName == "ID" && !hasPK {
			c.note = "pk"
		}
		prefix, ok := strings.CutSuffix(c.goName, "ID")
		if !ok || prefix == "" || !ints[c.goName] {
			continue
		}
		c.prefix, c.paired = prefix, held[prefix]
		snake := snakeCase(prefix)
		if orm.plural {
			c.refs = append(c.refs, plural(snake), snake)
		} else {
			c.refs = append(c.refs, snake, plural(snake))
		}
	}
	return cols
}

// modelTables are the table candidates of the repo model a field holds
// (directly, by pointer or in a slice), or nil if it holds none.
func (l *load) modelTables(t types.Type, orm *ormPreset) []string {
	for range 4 {
		switch u := types.Unalias(t).(type) {
		case *types.Pointer:
			t = u.Elem()
			continue
		case *types.Slice:
			t = u.Elem()
			continue
		case *types.Array:
			t = u.Elem()
			continue
		case *types.Named:
			obj := u.Origin().Obj()
			if _, ok := u.Underlying().(*types.Struct); !ok || obj.Pkg() == nil ||
				!l.isRepoPkg(obj.Pkg().Path()) || obj.Parent() != obj.Pkg().Scope() {
				return nil
			}
			if s, ok := l.tableNames[obj]; ok {
				return []string{s}
			}
			if s := l.declaredTable(u.Origin()); s != "" {
				return []string{s}
			}
			return tableCandidates(u.Origin(), orm)
		}
		return nil
	}
	return nil
}

func structOf(t types.Type) *types.Struct {
	if p, ok := t.Underlying().(*types.Pointer); ok {
		t = p.Elem()
	}
	s, _ := t.Underlying().(*types.Struct)
	return s
}

func isBunBaseModel(t types.Type) bool {
	n, ok := types.Unalias(t).(*types.Named)
	return ok && n.Obj().Name() == "BaseModel" && n.Obj().Pkg() != nil && ormFor(n.Obj().Pkg().Path()) != nil
}

// ormSkipped reports whether a field's tag keeps it out of the table.
func ormSkipped(tag reflect.StructTag) bool {
	for _, k := range []string{"xorm", "bun", "pg", "sql"} {
		if tag.Get(k) == "-" {
			return true
		}
	}
	g := tag.Get("gorm")
	return g == "-" || strings.HasPrefix(g, "-:")
}

// ormColumnName is a field's column: from its tag (xorm "'name' …", gorm
// "column:name", bun and go-pg "name,…"), else the snake-cased field name.
func ormColumnName(tag reflect.StructTag, field string) string {
	for _, w := range strings.Fields(tag.Get("xorm")) {
		if len(w) > 2 && w[0] == '\'' && w[len(w)-1] == '\'' {
			return w[1 : len(w)-1]
		}
	}
	for _, part := range strings.Split(tag.Get("gorm"), ";") {
		if k, v, ok := strings.Cut(part, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "column") && v != "" {
			return strings.TrimSpace(v)
		}
	}
	for _, k := range []string{"bun", "pg"} {
		if name, _, _ := strings.Cut(tag.Get(k), ","); name != "" && !strings.Contains(name, ":") {
			return name
		}
	}
	return snakeCase(field)
}

// ormPK reports whether a field's tag marks the primary key.
func ormPK(tag reflect.StructTag) bool {
	for _, w := range strings.Fields(tag.Get("xorm")) {
		if strings.EqualFold(w, "pk") {
			return true
		}
	}
	for _, part := range strings.Split(tag.Get("gorm"), ";") {
		if p := strings.TrimSpace(part); strings.EqualFold(p, "primaryKey") || strings.EqualFold(p, "primary_key") {
			return true
		}
	}
	for _, k := range []string{"bun", "pg"} {
		if _, opts, ok := strings.Cut(tag.Get(k), ","); ok && slices.Contains(strings.Split(opts, ","), "pk") {
			return true
		}
	}
	return false
}

// migrationFile matches files in migration code: models/migrations/v1_20/…,
// modelmigration/…, db/migrate/….
var migrationFile = regexp.MustCompile(`(?i)(^|/)[^/]*migrat[^/]*/`)

// addModelColumns gives the tables that have no columns yet (from migrations
// or DDL, which describe the database itself and so win) the columns of their
// models. Models sharing a table add the columns the earlier ones lack.
// Models declared in migration code are snapshots of a table at some past
// version (xorm migrations declare their own copies), so they count only for
// tables no other model describes.
func (x *extractor) addModelColumns() {
	current := map[string]bool{}
	for _, m := range x.models {
		if !migrationFile.MatchString(m.file) {
			current[m.table] = true
		}
	}
	var order []string
	byTable := map[string][]modelCol{}
	src := map[string][]any{}
	for _, m := range x.models {
		if current[m.table] && migrationFile.MatchString(m.file) {
			continue
		}
		id := sqlext.TableID(m.table)
		n := x.b.nodes[id]
		if n == nil {
			continue
		}
		if _, ok := n.Fields["columns"]; ok && byTable[id] == nil {
			continue
		}
		if byTable[id] == nil {
			order = append(order, id)
		}
		for _, c := range m.cols {
			if !slices.ContainsFunc(byTable[id], func(o modelCol) bool { return o.name == c.name }) {
				byTable[id] = append(byTable[id], c)
			}
		}
		if src[id] == nil {
			src[id] = []any{}
		}
		if m.file != "" && !slices.Contains(src[id], any(m.file)) {
			src[id] = append(src[id], m.file)
		}
	}
	// A table's key column, for "→ table.key"; "id" when its columns don't say.
	key := func(id string) string {
		var cols []any
		if n := x.b.nodes[id]; n != nil {
			cols, _ = n.Fields["columns"].([]any)
		}
		pk := ""
		for _, c := range cols {
			if r, ok := c.([]any); ok && len(r) == 3 && r[2] == "pk" {
				if pk != "" {
					return "id"
				}
				pk, _ = r[0].(string)
			}
		}
		for _, c := range byTable[id] {
			if pk == "" && c.note == "pk" {
				pk = c.name
			}
		}
		if pk == "" {
			return "id"
		}
		return pk
	}
	table := func(cands []string) (string, string) {
		for _, t := range cands {
			id := sqlext.TableID(t)
			if n := x.b.nodes[id]; n != nil && n.Kind == graph.KindTable {
				return id, n.Label
			}
		}
		return "", ""
	}
	// What the repo's own pairings say an Xxx prefix means (Repo *Repository
	// next to RepoID), for XxxID columns in models without the Xxx field. The
	// table most pairings give wins; ties go to the first name.
	votes := map[string]map[string]int{}
	for _, id := range order {
		for _, c := range byTable[id] {
			if _, t := table(c.paired); t != "" {
				if votes[c.prefix] == nil {
					votes[c.prefix] = map[string]int{}
				}
				votes[c.prefix][t]++
			}
		}
	}
	alias := map[string]string{}
	for p, ts := range votes {
		for t, n := range ts {
			if b := alias[p]; b == "" || n > ts[b] || n == ts[b] && t < b {
				alias[p] = t
			}
		}
	}
	notes := map[string][]string{}
	for _, id := range order {
		for _, c := range byTable[id] {
			note := c.note
			if note == "" && c.prefix != "" {
				cands := slices.Concat(c.paired, c.refs)
				if a := alias[c.prefix]; a != "" {
					cands = append(cands, a)
				}
				if tid, t := table(cands); t != "" {
					note = "→ " + t + "." + key(tid)
				}
			}
			if note == "" {
				if _, t := table(c.rel); t != "" {
					note = "→ " + t
				}
			}
			notes[id] = append(notes[id], note)
		}
	}
	for _, id := range order {
		n := x.b.nodes[id]
		cols := make([]any, 0, len(byTable[id]))
		for i, c := range byTable[id] {
			cols = append(cols, []any{c.name, c.typ, notes[id][i]})
		}
		if n.Fields == nil {
			n.Fields = map[string]any{}
		}
		n.Fields["columns"] = cols
		n.Fields["source"] = src[id]
	}
}
