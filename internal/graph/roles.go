package graph

import (
	"bytes"
	"math"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Roles mark supporting code so the viewer's Features level can show a
// feature's spine (entry point, business logic, effects) without it. They come
// only from heuristics over the graph and the source; nobody annotates code.
const (
	RoleWiring      = "wiring"      // constructors, main and what only main reaches to set things up
	RoleUtility     = "utility"     // widely used leaf helpers without effects
	RolePassthrough = "passthrough" // short functions that forward to one other function
	RoleGenerated   = "generated"   // generated code and mocks
	RoleUnreachable = "unreachable" // no path from any entry point
)

// Thresholds for the role heuristics.
const (
	// UtilityCallers is how many distinct callers make a leaf helper a utility.
	UtilityCallers = 3
	// UtilityEntries is how many distinct entry points reaching a leaf helper make it a utility.
	UtilityEntries = 2
	// UtilitySpan is the longest endLine-line of a helper that counts as a
	// utility for being used from another module or by two entry points.
	UtilitySpan = 12
	// ShortSpan is the longest endLine-line of a passthrough, or of a function
	// that only forwards to utilities.
	ShortSpan = 6
	// UtilityShare is the share of a repo's functions, by utilityhood, that
	// count as widely used (utilities, or shared when they have effects).
	UtilityShare = 0.02
	// WidelyUsedCallers is the fewest callers a widely used function has.
	WidelyUsedCallers = 5
)

var (
	// effects the extractors can miss (dynamic SQL, ORM and key-value store
	// calls, Go HTTP requests, file and process I/O): a function whose source
	// does any of this is never a utility, a passthrough or derived wiring.
	// Generic HTTP and queue wrappers (fetch, Publish) aren't here: fetches and
	// publishes edges show those effects on the callers.
	dataEffect = regexp.MustCompile(`\.(Query|QueryRow|QueryContext|QueryRowContext|Queryx|QueryRowx|Exec|ExecContext|NamedExec|Prepare|PrepareContext|BeginTx)\(` +
		`|(?i:\b(select\s[\s\S]{1,200}?\sfrom|insert\s+into|delete\s+from|update\s+\w+\s+set)\s)` +
		`|\.(Model|Where|Preload|Joins|Raw|First|Save|Updates|Insert|Upsert|Sync|AutoMigrate|Bucket|CreateBucket|CreateBucketIfNotExists)\(|\.(View|Update|Batch)\((func\(tx|fn\))` +
		`|\bhttp\.(Get|Post|PostForm|Head)\(|\.Do\(req|\bos\.(WriteFile|Create|Remove|RemoveAll|Mkdir|MkdirAll|Rename)\(|\bexec\.Command|\bnet\.Dial`)
	// an API path in a string ("/api/comments", `/orders/${id}`): a frontend
	// function that calls the backend, even when no fetches edge was found.
	// Not counted against wiring, which registers routes by path.
	pathLiteral     = regexp.MustCompile(`['"` + "`" + `]/(api/)?[a-z]\w*`)
	generatedHeader = regexp.MustCompile(`(?m)^// Code generated .* DO NOT EDIT\.$`)
	ctorName        = regexp.MustCompile(`^(New|new)([A-Z0-9_].*)?$`)
	initName        = regexp.MustCompile(`^init(#\d+)?$`)
	// registration APIs: wiring code reaches the rest of the program by passing
	// handlers to these, so calling them doesn't stop a function being wiring.
	registerPrefix = regexp.MustCompile(`^(Register|Subscribe|Handle|Mount|Schedule|AddRoute|AddFunc|AddJob|AddHandler)`)
	registerExact  = map[string]bool{"Every": true, "Add": true, "Use": true, "On": true, "Get": true, "Post": true, "Put": true, "Delete": true,
		"Patch": true, "Group": true, "Route": true, "Cron": true, "Listen": true, "Any": true, "Static": true}
)

// ReadFile reads a repo file by its graph path (relative to the repo root).
type ReadFile func(file string) ([]byte, error)

// AssignRoles sets fields.role on function nodes that look like supporting
// code, and returns how many nodes got each role. Nodes without a role are
// core. External, entry, test and proposal nodes never get one, except that
// an entry function named main is wiring. When the repo has no route, page,
// job, subscriber or command entries (a library), exported functions act as
// entry points and get fields.entry_reason = "exported". read may be nil.
func AssignRoles(g *Graph, read ReadFile) map[string]int {
	ix := NewIndex(g)
	counts := map[string]int{}
	role := map[string]string{}

	isRepo := func(id string) bool {
		n := ix.Node[id]
		return n != nil && !n.External && n.Kind != KindTest
	}
	isMain := func(n *Node) bool { return n.Entry && n.Kind == KindFunction && n.Label == "main" }

	// entries, plus exported functions in a library
	library := true
	for _, n := range g.Nodes {
		if n.Entry && (n.Kind == KindRoute || n.Kind == KindPage || n.Kind == KindJob || n.Kind == KindSubscriber || n.Kind == KindCommand) {
			library = false
			break
		}
	}
	entry := map[string]bool{}
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.Entry && !n.External {
			entry[n.ID] = true
		}
		if library && !n.Entry && !n.External && n.Kind == KindFunction && exported(n) {
			entry[n.ID] = true
			setField(n, "entry_reason", "exported")
		}
	}

	// candidates: repo functions that aren't entry points
	cand := map[string]bool{}
	for _, n := range g.Nodes {
		if n.Kind != KindFunction || n.External || strings.HasPrefix(n.ID, "new:") {
			continue
		}
		if n.Entry && !isMain(&n) {
			continue
		}
		cand[n.ID] = true
	}

	// per-node facts
	type facts struct {
		callers     map[string]bool // non-test, non-self
		mods        map[string]bool // modules of callers other than the node's own
		callees     map[string]bool // repo nodes called or rendered
		effect      bool            // any of the effects below, or an API path literal in the source
		graphEffect bool            // reads, writes, publishes, fetches, or calls an external node
		byEntry     bool            // called directly by an entry node
		span        int
		hasSpan     bool
		register    bool
		dataEffect  bool // effect found in the source, other than a path literal
		delegates   bool // a Go method calling through one of its receiver's fields (an injected dependency)
	}
	F := map[string]*facts{}
	src := sources{read: read, files: map[string][][]byte{}}
	for id := range cand {
		n := ix.Node[id]
		f := &facts{callers: map[string]bool{}, mods: map[string]bool{}, callees: map[string]bool{}}
		for _, e := range ix.In[id] {
			c := ix.Node[e.From]
			if e.From == id || c == nil || c.Kind == KindTest || (e.Type != Calls && e.Type != Renders && e.Type != Subscribes) {
				continue
			}
			f.callers[e.From] = true
			if c.Module != n.Module && !c.External {
				f.mods[c.Module] = true
			}
			if c.Entry && !isMain(c) {
				f.byEntry = true
			}
		}
		for _, e := range ix.Out[id] {
			switch e.Type {
			case Reads, Writes, Publishes, Fetches:
				f.effect, f.graphEffect = true, true
			case Calls, Renders:
				if e.To == id {
					continue
				}
				if t := ix.Node[e.To]; t != nil && t.External {
					f.effect, f.graphEffect = true, true
				} else if isRepo(e.To) {
					f.callees[e.To] = true
				}
			}
		}
		if read != nil && n.File != "" && n.Line > 0 {
			body := src.body(n)
			if dataEffect.Match(body) {
				f.effect, f.dataEffect = true, true
			} else if pathLiteral.Match(body) {
				f.effect = true
			}
			f.delegates = delegates(body)
		}
		if n.Line > 0 {
			f.hasSpan = true
			if n.EndLine > n.Line {
				f.span = n.EndLine - n.Line
			}
		}
		name := n.Label
		if i := strings.LastIndex(name, "."); i >= 0 {
			name = name[i+1:]
		}
		f.register = registerExact[name] || registerPrefix.MatchString(name)
		F[id] = f
	}

	// generated: header or mock path
	genFile := map[string]bool{}
	checked := map[string]bool{}
	for id := range cand {
		file := ix.Node[id].File
		if file == "" {
			continue
		}
		if !checked[file] {
			checked[file] = true
			genFile[file] = mockPath(file) || (read != nil && generatedSource(read, file))
		}
		if genFile[file] {
			role[id] = RoleGenerated
		}
	}

	// reachability from the entries; trusted for a language only when the
	// entries reach at least half its functions. Entry points the extractors
	// don't see (framework callbacks, CLI actions held in struct fields) can
	// leave most code with no path, and then a missing path means little.
	seen := map[string]bool{}
	var q []string
	for id := range entry {
		seen[id] = true
		q = append(q, id)
	}
	for len(q) > 0 {
		id := q[0]
		q = q[1:]
		if n := ix.Node[id]; n != nil && n.External && !entry[id] {
			continue
		}
		for _, e := range ix.Out[id] {
			if !seen[e.To] {
				seen[e.To] = true
				q = append(q, e.To)
			}
		}
	}
	total, reached := map[string]int{}, map[string]int{}
	for id := range cand {
		if role[id] == RoleGenerated {
			continue
		}
		l := langOf(id)
		total[l]++
		if seen[id] {
			reached[l]++
		}
	}
	trusted := func(id string) bool { l := langOf(id); return len(entry) > 0 && reached[l]*2 >= total[l] }
	// dead reports a function no entry reaches, in a language where that means something
	dead := func(id string) bool { return !seen[id] && trusted(id) }

	// wiring: main and init; constructors that only wiring (or dead code)
	// calls; and functions only wiring calls that themselves only construct
	// or register things
	for id := range cand {
		if n := ix.Node[id]; role[id] == "" && (isMain(n) || initName.MatchString(n.Label)) {
			role[id] = RoleWiring
		}
	}
	for changed := true; changed; {
		changed = false
		for id, f := range F {
			n := ix.Node[id]
			if role[id] != "" || n.Entry || entry[id] && library {
				continue
			}
			ctor := !strings.Contains(n.Label, ".") && ctorName.MatchString(n.Label) && (read == nil || returnsValue(n, src))
			byWiring := true
			for c := range f.callers {
				if role[c] != RoleWiring && !(ctor && dead(c)) {
					byWiring = false
					break
				}
			}
			if !byWiring {
				continue
			}
			ok := ctor
			if !ok && len(f.callers) > 0 && !f.graphEffect && !f.dataEffect {
				ok = true
				for c := range f.callees {
					if role[c] != RoleWiring && !(F[c] != nil && F[c].register) {
						ok = false
						break
					}
				}
			}
			if ok {
				role[id] = RoleWiring
				changed = true
			}
		}
	}

	// unreachable: no path from an entry
	for id := range cand {
		if role[id] == "" && dead(id) {
			role[id] = RoleUnreachable
		}
	}

	// utility: a leaf helper (no effects, calls only utilities) that many use
	reach := entryReach(ix, entry, UtilityEntries)
	for changed := true; changed; {
		changed = false
		for id, f := range F {
			if role[id] != "" || f.effect || f.delegates || f.byEntry || entry[id] {
				continue
			}
			allUtil := true
			for c := range f.callees {
				if role[c] != RoleUtility {
					allUtil = false
					break
				}
			}
			if !allUtil {
				continue
			}
			// three callers is enough on its own; the weaker signals (used from
			// another module, or by two features) only count for short helpers,
			// so longer domain logic used in two places stays on the map
			short := f.hasSpan && f.span <= UtilitySpan
			used := len(f.callers) >= UtilityCallers || short && (len(f.mods) > 0 || reach[id] >= UtilityEntries)
			if !used && len(f.callers) > 0 {
				byUtil := true
				for c := range f.callers {
					if role[c] != RoleUtility {
						byUtil = false
						break
					}
				}
				used = byUtil
			}
			// a short function that only forwards to utilities is one too
			if !used && len(f.callees) > 0 && f.hasSpan && f.span <= ShortSpan {
				used = true
			}
			if used {
				role[id] = RoleUtility
				changed = true
			}
		}
	}

	// widely used: the functions with the highest utilityhood, a measure from
	// trace summarisation (Hamou-Lhadj & Lethbridge, "Summarizing the Content
	// of Large Traces to Facilitate the Understanding of the Behaviour of a
	// Software System", ICPC 2006): many callers, few callees. Wide call sites
	// don't count, so a registry or a much-implemented interface can't make
	// its targets look widely used. One that reaches no effects (WithTx,
	// GetEngine, a logger) is a utility; one with effects, its own or its
	// callees', is marked shared: traces show it, but don't go into it.
	// Effects of direct callees count too: a service function that only
	// orchestrates lookups isn't plumbing. Only one level: followed further,
	// nearly everything in a big repo reaches some effect.
	reaches := func(id string) bool {
		if F[id].effect {
			return true
		}
		for _, e := range ix.Out[id] {
			if e.Type == Calls && !ix.Wide(e) && F[e.To] != nil && F[e.To].effect {
				return true
			}
		}
		return false
	}
	for _, id := range widelyUsed(ix, func(id string) bool {
		return F[id] != nil && role[id] == "" && !entry[id]
	}) {
		if reaches(id) || F[id].delegates {
			setField(ix.Node[id], "shared", true)
			continue
		}
		role[id] = RoleUtility
	}

	// passthrough: short, no effects, exactly one repo callee
	for id, f := range F {
		if role[id] != "" || f.effect || f.byEntry || entry[id] || !f.hasSpan || f.span > ShortSpan || len(f.callees) != 1 {
			continue
		}
		role[id] = RolePassthrough
	}

	for i := range g.Nodes {
		n := &g.Nodes[i]
		if r := role[n.ID]; r != "" {
			setField(n, "role", r)
			counts[r]++
		}
	}
	return counts
}

// widelyUsed returns the eligible repo functions in the top UtilityShare by
// utilityhood, U = fanIn/N · (1 − log(fanOut+1)/log N), where N is the number
// of repo functions and fan-in and fan-out count distinct repo functions over
// calls that aren't wide. Only functions with at least WidelyUsedCallers
// callers qualify, so a small repo marks few or none.
func widelyUsed(ix *Index, eligible func(id string) bool) []string {
	repoFn := func(id string) bool {
		n := ix.Node[id]
		return n != nil && n.Kind == KindFunction && !n.External && !strings.HasPrefix(id, "new:")
	}
	var fns []string
	for _, n := range ix.G.Nodes {
		if repoFn(n.ID) {
			fns = append(fns, n.ID)
		}
	}
	N := float64(len(fns))
	if N < 2 {
		return nil
	}
	type score struct {
		id string
		u  float64
	}
	var scores []score
	for _, id := range fns {
		if !eligible(id) {
			continue
		}
		in, out := map[string]bool{}, map[string]bool{}
		for _, e := range ix.In[id] {
			if e.Type == Calls && e.From != id && !ix.Wide(e) {
				if c := ix.Node[e.From]; c != nil && c.Kind != KindTest {
					in[e.From] = true
				}
			}
		}
		if len(in) < WidelyUsedCallers {
			continue
		}
		for _, e := range ix.Out[id] {
			if e.Type == Calls && e.To != id && !ix.Wide(e) && repoFn(e.To) {
				out[e.To] = true
			}
		}
		u := float64(len(in)) / N * (1 - math.Log(float64(len(out))+1)/math.Log(N))
		if u > 0 {
			scores = append(scores, score{id, u})
		}
	}
	sort.Slice(scores, func(i, j int) bool {
		if scores[i].u != scores[j].u {
			return scores[i].u > scores[j].u
		}
		return scores[i].id < scores[j].id
	})
	k := int(UtilityShare * N)
	if k > len(scores) {
		k = len(scores)
	}
	out := make([]string, k)
	for i := range out {
		out[i] = scores[i].id
	}
	return out
}

// entryReach counts, per node, the distinct entry points that reach it
// without passing through another entry point, up to cap.
func entryReach(ix *Index, entry map[string]bool, cap int) map[string]int {
	out := map[string]int{}
	for start := range entry {
		seen := map[string]bool{start: true}
		q := []string{start}
		for len(q) > 0 {
			id := q[0]
			q = q[1:]
			// stop at external nodes and at other entry points, so a page that
			// fetches a route doesn't count as a second entry for the route's code
			if n := ix.Node[id]; n != nil && (n.External || entry[id]) && id != start {
				continue
			}
			for _, e := range ix.Out[id] {
				if seen[e.To] {
					continue
				}
				seen[e.To] = true
				if out[e.To] < cap {
					out[e.To]++
				}
				q = append(q, e.To)
			}
		}
	}
	return out
}

func setField(n *Node, k string, v any) {
	if n.Fields == nil {
		n.Fields = map[string]any{}
	}
	n.Fields[k] = v
}

// exported reports whether a function is part of its package's public API:
// every segment of a Go label starts upper-case; a TS node is a top-level export.
func exported(n *Node) bool {
	switch {
	case strings.HasPrefix(n.ID, "go:"):
		for _, seg := range strings.Split(n.Label, ".") {
			r, _ := utf8.DecodeRuneInString(seg)
			if !unicode.IsUpper(r) {
				return false
			}
		}
		return true
	case strings.HasPrefix(n.ID, "ts:"):
		i := strings.Index(n.ID, "#")
		return i >= 0 && !strings.Contains(n.ID[i+1:], ".")
	}
	return false
}

var mockFile = regexp.MustCompile(`^mock([_A-Z].*)?$|_mock$`)

func mockPath(file string) bool {
	if mockFile.MatchString(strings.TrimSuffix(path.Base(file), path.Ext(file))) {
		return true
	}
	for _, seg := range strings.Split(path.Dir(file), "/") {
		if seg == "mocks" || seg == "__mocks__" {
			return true
		}
	}
	return false
}

// generatedSource checks the start of a file for the standard generated-code header.
func generatedSource(read ReadFile, file string) bool {
	b, err := read(file)
	if err != nil {
		return false
	}
	if len(b) > 4096 {
		b = b[:4096]
	}
	return generatedHeader.Match(bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")))
}

// sources caches repo files split into lines.
type sources struct {
	read  ReadFile
	files map[string][][]byte
}

// body returns a node's source lines, line through endLine.
func (s sources) body(n *Node) []byte {
	lines, ok := s.files[n.File]
	if !ok {
		b, err := s.read(n.File)
		if err == nil {
			lines = bytes.Split(b, []byte("\n"))
		}
		s.files[n.File] = lines
	}
	from, to := n.Line-1, n.EndLine
	if to < n.Line {
		to = n.Line
	}
	if from < 0 || from >= len(lines) {
		return nil
	}
	if to > len(lines) {
		to = len(lines)
	}
	return bytes.Join(lines[from:to], []byte("\n"))
}

var goRecv = regexp.MustCompile(`^func \((\w+) `)

// delegates reports whether a Go method calls a method on one of its
// receiver's fields, like s.repo.Find(…): a call through an injected
// dependency, usually an interface the call graph can't see through.
func delegates(body []byte) bool {
	m := goRecv.FindSubmatch(body)
	if m == nil {
		return false
	}
	re, err := regexp.Compile(`\b` + string(m[1]) + `\.\w+\.\w+\(`)
	return err == nil && re.Match(body)
}

func langOf(id string) string {
	if i := strings.IndexByte(id, ':'); i >= 0 {
		return id[:i]
	}
	return ""
}

// returnsValue reports whether a Go function's signature declares a result,
// so NewReleasePost(ctx) (a handler) isn't taken for a constructor. Non-Go
// functions always pass.
func returnsValue(n *Node, src sources) bool {
	if !strings.HasPrefix(n.ID, "go:") {
		return true
	}
	body := src.body(n)
	i := bytes.IndexByte(body, '(')
	if i < 0 {
		return true
	}
	depth := 0
	for j := i; j < len(body); j++ {
		switch body[j] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				rest := body[j+1:]
				if k := bytes.IndexByte(rest, '{'); k >= 0 {
					rest = rest[:k]
				}
				return len(bytes.TrimSpace(rest)) > 0
			}
		}
	}
	return true
}
