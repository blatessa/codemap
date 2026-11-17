package main

import (
	"codemap/internal/build"
	"codemap/internal/extract/goext"
	"codemap/internal/extract/tsext"
)

func init() {
	build.Extractors = append(build.Extractors, goext.Extract, tsext.Extract)
}
