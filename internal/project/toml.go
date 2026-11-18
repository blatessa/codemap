package project

import (
	"bytes"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// TOML has no top-level arrays, so list files keep their entries as an array of
// tables under a singular key (PLAN.md §4).
const (
	AreaKey  = "area"
	BlockKey = "block"
	ViewKey  = "view"
	HideKey  = "hide"
)

// MarshalTOML encodes v as TOML. Free-form maps (declared nodes, proposal
// sketches) are written with their well-known keys first (id, from, to, kind,
// label, ...) and the rest sorted, so a round trip is stable.
func MarshalTOML(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := toml.NewEncoder(&buf)
	enc.SetIndentTables(false)
	if err := enc.Encode(prepare(reflect.ValueOf(v), 0)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// UnmarshalTOML decodes TOML into v.
func UnmarshalTOML(b []byte, v any) error { return toml.Unmarshal(b, v) }

// MarshalList encodes a list file: each entry becomes a [[key]] table.
func MarshalList[T any](key string, list []T) ([]byte, error) {
	if len(list) == 0 {
		return []byte{}, nil
	}
	return MarshalTOML(map[string][]T{key: list})
}

// UnmarshalList decodes a list file written by MarshalList.
func UnmarshalList[T any](key string, b []byte, list *[]T) error {
	var doc map[string][]T
	if err := toml.Unmarshal(b, &doc); err != nil {
		return err
	}
	for k := range doc {
		if k != key {
			return fmt.Errorf("unexpected key %q (entries are [[%s]] tables)", k, key)
		}
	}
	*list = doc[key]
	return nil
}

// firstKeys come first, in this order, in free-form maps.
var firstKeys = []string{"id", "name", "from", "to", "kind", "label", "module", "external", "entry"}

var anyType = reflect.TypeOf((*any)(nil)).Elem()

// prepare rewrites free-form values for encoding: maps become structs whose field
// order is the key order we want, integral float64s (from JSON) become integers,
// and nils are dropped since TOML has no null. Structs and typed slices pass
// through unchanged unless they contain free-form values.
func prepare(v reflect.Value, depth int) any {
	if !v.IsValid() {
		return nil
	}
	switch v.Kind() {
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return nil
		}
		return prepare(v.Elem(), depth)
	case reflect.Float64, reflect.Float32:
		f := v.Float()
		if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
			return int64(f)
		}
		return f
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String {
			return v.Interface()
		}
		return orderedMap(v, depth)
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.IsNil() {
			return nil
		}
		if !hasFreeForm(v.Type().Elem()) {
			return v.Interface()
		}
		out := make([]any, 0, v.Len())
		for i := 0; i < v.Len(); i++ {
			if x := prepare(v.Index(i), depth+1); x != nil {
				out = append(out, x)
			}
		}
		return out
	case reflect.Struct:
		if !hasFreeForm(v.Type()) {
			return v.Interface()
		}
		// Rebuild the struct with prepared values, keeping tags and order.
		t := v.Type()
		var fields []reflect.StructField
		var vals []reflect.Value
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			fv := v.Field(i)
			if hasFreeForm(f.Type) {
				p := prepare(fv, depth+1)
				if p == nil {
					continue
				}
				fields = append(fields, reflect.StructField{Name: f.Name, Type: anyType, Tag: f.Tag})
				vals = append(vals, reflect.ValueOf(&p).Elem())
				continue
			}
			fields = append(fields, reflect.StructField{Name: f.Name, Type: f.Type, Tag: f.Tag})
			vals = append(vals, fv)
		}
		out := reflect.New(reflect.StructOf(fields)).Elem()
		for i, fv := range vals {
			out.Field(i).Set(fv)
		}
		return out.Interface()
	}
	return v.Interface()
}

// hasFreeForm reports whether t contains maps or interfaces that prepare rewrites.
func hasFreeForm(t reflect.Type) bool {
	return freeForm(t, map[reflect.Type]bool{})
}

func freeForm(t reflect.Type, seen map[reflect.Type]bool) bool {
	if seen[t] {
		return false
	}
	seen[t] = true
	switch t.Kind() {
	case reflect.Interface:
		return true
	case reflect.Map:
		return t.Elem().Kind() == reflect.Interface || freeForm(t.Elem(), seen)
	case reflect.Pointer, reflect.Slice, reflect.Array:
		return freeForm(t.Elem(), seen)
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			if t.Field(i).IsExported() && freeForm(t.Field(i).Type, seen) {
				return true
			}
		}
	}
	return false
}

func orderedMap(m reflect.Value, depth int) any {
	keys := make([]string, 0, m.Len())
	for _, k := range m.MapKeys() {
		keys = append(keys, k.String())
	}
	rank := func(k string) int {
		for i, f := range firstKeys {
			if f == k {
				return i
			}
		}
		return len(firstKeys)
	}
	sort.Slice(keys, func(i, j int) bool {
		ri, rj := rank(keys[i]), rank(keys[j])
		if ri != rj {
			return ri < rj
		}
		return keys[i] < keys[j]
	})
	// Tables below the top level (a node's links, say) are written inline.
	opts := ""
	if depth > 0 {
		opts = ",inline"
	}
	var fields []reflect.StructField
	var vals []any
	plain := map[string]any{}
	for _, k := range keys {
		p := prepare(m.MapIndex(reflect.ValueOf(k).Convert(m.Type().Key())), depth+1)
		if p == nil {
			continue
		}
		plain[k] = p
		fields = append(fields, reflect.StructField{
			Name: "F" + strconv.Itoa(len(fields)),
			Type: anyType,
			Tag:  reflect.StructTag(`toml:` + strconv.Quote(k+opts)),
		})
		vals = append(vals, p)
	}
	for _, k := range keys {
		if strings.Contains(k, ",") {
			// A struct tag can't name this key; fall back to a map (sorted keys).
			return plain
		}
	}
	out := reflect.New(reflect.StructOf(fields)).Elem()
	for i, p := range vals {
		out.Field(i).Set(reflect.ValueOf(&p).Elem())
	}
	return out.Interface()
}
