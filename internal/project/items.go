package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// A proposal's [[item]] tables are change requests (PLAN.md §6): each one
// points at a node, module, edge ("from -> to") or file and says what to do.
// Items are free-form maps like the rest of the sketch; these are the keys the
// tools know about.
var (
	ItemKinds    = []string{"change", "add", "remove", "move", "rename", "test", "question"}
	ItemStatuses = []string{"open", "done", "wontfix"}
)

// ItemStr returns a string field of an item ("" when missing or not a string).
func ItemStr(it map[string]any, k string) string {
	s, _ := it[k].(string)
	return s
}

// ItemLines returns an item's lines = [a, b] (b = a for a single line).
func ItemLines(it map[string]any) (a, b int, ok bool) {
	toInt := func(v any) (int, bool) {
		switch x := v.(type) {
		case int64:
			return int(x), true
		case int:
			return x, true
		case float64:
			return int(x), true
		case json.Number:
			n, err := x.Int64()
			return int(n), err == nil
		}
		return 0, false
	}
	switch l := it["lines"].(type) {
	case []any:
		if len(l) == 0 {
			return 0, 0, false
		}
		a, ok = toInt(l[0])
		b = a
		if len(l) > 1 {
			if x, ok2 := toInt(l[len(l)-1]); ok2 {
				b = x
			}
		}
	case []int64:
		if len(l) == 0 {
			return 0, 0, false
		}
		a, b, ok = int(l[0]), int(l[len(l)-1]), true
	case []int:
		if len(l) == 0 {
			return 0, 0, false
		}
		a, b, ok = l[0], l[len(l)-1], true
	default:
		a, ok = toInt(l)
		b = a
	}
	if b < a {
		b = a
	}
	return a, b, ok && a > 0
}

// FindItem returns the index of the item with this id, or -1.
func (p *Proposal) FindItem(id string) int {
	for i, it := range p.Items {
		if ItemStr(it, "id") == id {
			return i
		}
	}
	return -1
}

// NextItemID returns "i<N>", one past the highest i<N> in use.
func (p *Proposal) NextItemID() string {
	max := 0
	for _, it := range p.Items {
		id := ItemStr(it, "id")
		if n, err := strconv.Atoi(strings.TrimPrefix(id, "i")); err == nil && strings.HasPrefix(id, "i") && n > max {
			max = n
		}
	}
	return "i" + strconv.Itoa(max+1)
}

// CleanItem drops computed keys (anchor) and nils from an item sent by a client.
func CleanItem(it map[string]any) map[string]any {
	out := make(map[string]any, len(it))
	for k, v := range it {
		if k == "anchor" || v == nil {
			continue
		}
		out[k] = v
	}
	return out
}

// ---- editing a proposal file in place ----

// The functions below change a proposal file's frontmatter while keeping the
// rest as written (comments, order, the body). Each checks its result by
// parsing it again and returns an error on any surprise, so callers can fall
// back to re-marshalling the whole proposal.

var errNoFrontmatter = errors.New("no frontmatter")

func fmLines(file []byte) (lines []string, body string, err error) {
	fm, body, ok, err := SplitFrontmatter(string(file))
	if err != nil {
		return nil, "", err
	}
	if !ok {
		return nil, "", errNoFrontmatter
	}
	lines = strings.SplitAfter(fm, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if n := len(lines); n > 0 && !strings.HasSuffix(lines[n-1], "\n") {
		lines[n-1] += "\n"
	}
	return lines, body, nil
}

func joinFM(lines []string, body string) []byte {
	d := FrontmatterDelim + "\n"
	return []byte(d + strings.Join(lines, "") + d + body)
}

func kvLine(k string, v any) (string, error) {
	b, err := MarshalTOML(map[string]any{k: v})
	if err != nil {
		return "", err
	}
	s := string(b)
	if strings.Count(s, "\n") != 1 {
		return "", fmt.Errorf("%s: value does not fit on one line", k)
	}
	return s, nil
}

func isTableHeader(l string) bool { return strings.HasPrefix(strings.TrimSpace(l), "[") }

func lineKey(l string) (string, bool) {
	t := strings.TrimSpace(l)
	if t == "" || strings.HasPrefix(t, "#") || isTableHeader(t) {
		return "", false
	}
	k, _, ok := strings.Cut(t, "=")
	if !ok {
		return "", false
	}
	return strings.Trim(strings.TrimSpace(k), `"'`), true
}

// SetFrontmatter sets top-level keys in a proposal file's TOML frontmatter. An
// existing "key = ..." line is replaced; a new key goes after the last
// top-level key, before the first table.
func SetFrontmatter(file []byte, set [][2]string) ([]byte, error) {
	lines, body, err := fmLines(file)
	if err != nil {
		return nil, err
	}
	top := len(lines)
	for i, l := range lines {
		if isTableHeader(l) {
			top = i
			break
		}
	}
	for _, kv := range set {
		line, err := kvLine(kv[0], kv[1])
		if err != nil {
			return nil, err
		}
		found := false
		for i := 0; i < top; i++ {
			if k, ok := lineKey(lines[i]); ok && k == kv[0] {
				lines[i] = line
				found = true
			}
		}
		if !found {
			at := 0
			for i := 0; i < top; i++ {
				if t := strings.TrimSpace(lines[i]); t != "" && !strings.HasPrefix(t, "#") {
					at = i + 1
				}
			}
			lines = append(lines[:at], append([]string{line}, lines[at:]...)...)
			top++
		}
	}
	out := joinFM(lines, body)
	var check map[string]any
	fm, _, _, _ := SplitFrontmatter(string(out))
	if err := UnmarshalTOML([]byte(fm), &check); err != nil {
		return nil, err
	}
	for _, kv := range set {
		if check[kv[0]] != kv[1] {
			return nil, fmt.Errorf("could not set %s in place", kv[0])
		}
	}
	return out, nil
}

// AppendItem adds an [[item]] table at the end of the frontmatter.
func AppendItem(file []byte, item map[string]any) ([]byte, error) {
	lines, body, err := fmLines(file)
	if err != nil {
		return nil, err
	}
	tbl, err := MarshalTOML(map[string]any{"item": []map[string]any{item}})
	if err != nil {
		return nil, err
	}
	if n := len(lines); n > 0 && strings.TrimSpace(lines[n-1]) != "" {
		lines = append(lines, "\n")
	}
	lines = append(lines, string(tbl))
	out := joinFM(lines, body)
	p, err := ParseProposal(out)
	if err != nil {
		return nil, err
	}
	if len(p.Items) == 0 || !sameJSON(p.Items[len(p.Items)-1], item) {
		return nil, errors.New("could not append the item in place")
	}
	return out, nil
}

// PatchItem sets (or, for nil values, removes) keys of the item with this id.
func PatchItem(file []byte, id string, set map[string]any) ([]byte, error) {
	lines, body, err := fmLines(file)
	if err != nil {
		return nil, err
	}
	// find the [[item]] table whose id matches
	start, end := -1, -1
	for i := 0; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != "[[item]]" {
			continue
		}
		j := i + 1
		for j < len(lines) && !isTableHeader(lines[j]) {
			j++
		}
		for k := i + 1; k < j; k++ {
			if key, ok := lineKey(lines[k]); ok && key == "id" {
				var v map[string]any
				if UnmarshalTOML([]byte(lines[k]), &v) == nil && v["id"] == id {
					start, end = i, j
				}
			}
		}
		if start >= 0 {
			break
		}
		i = j - 1
	}
	if start < 0 {
		return nil, fmt.Errorf("no item %q in place", id)
	}
	keys := sortedKeys(set)
	for _, k := range keys {
		v := set[k]
		at := -1
		for i := start + 1; i < end; i++ {
			if key, ok := lineKey(lines[i]); ok && key == k {
				at = i
			}
		}
		if v == nil {
			if at >= 0 {
				lines = append(lines[:at], lines[at+1:]...)
				end--
			}
			continue
		}
		line, err := kvLine(k, v)
		if err != nil {
			return nil, err
		}
		if at >= 0 {
			lines[at] = line
			continue
		}
		last := start
		for i := start + 1; i < end; i++ {
			if strings.TrimSpace(lines[i]) != "" {
				last = i
			}
		}
		lines = append(lines[:last+1], append([]string{line}, lines[last+1:]...)...)
		end++
	}
	out := joinFM(lines, body)
	p, err := ParseProposal(out)
	if err != nil {
		return nil, err
	}
	i := p.FindItem(id)
	if i < 0 {
		return nil, errors.New("item lost")
	}
	for k, v := range set {
		if got, has := p.Items[i][k]; (v == nil) == has || (v != nil && !sameJSON(got, v)) {
			return nil, fmt.Errorf("could not set %s in place", k)
		}
	}
	return out, nil
}

func sortedKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	for i := 1; i < len(ks); i++ {
		for j := i; j > 0 && ks[j] < ks[j-1]; j-- {
			ks[j], ks[j-1] = ks[j-1], ks[j]
		}
	}
	return ks
}

// sameJSON compares two values by their JSON form (TOML gives int64, JSON float64).
func sameJSON(a, b any) bool {
	var x, y any
	ja, err1 := json.Marshal(a)
	jb, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	json.Unmarshal(ja, &x)
	json.Unmarshal(jb, &y)
	return reflect.DeepEqual(x, y)
}
