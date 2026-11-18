package main

import (
	"github.com/blatessa/codemap/internal/build"
	"github.com/blatessa/codemap/internal/extract/goext"
	"github.com/blatessa/codemap/internal/extract/tsext"
)

func init() {
	build.Extractors = append(build.Extractors, goext.Extract, tsext.Extract)
}
