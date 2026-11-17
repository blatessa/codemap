// Package web embeds the built viewer (viewer/, built with `npm run build`).
package web

import "embed"

// Dist holds the viewer's static files under "dist/". Serve it with
// fs.Sub(web.Dist, "dist"). The directory always contains .keep, so the
// embed pattern matches even before the viewer is built.
//
//go:embed all:dist
var Dist embed.FS
