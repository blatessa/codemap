module commands

go 1.23

require (
	github.com/spf13/cobra v1.0.0
	github.com/urfave/cli/v2 v2.0.0
)

// Signature-only stand-ins for the CLI libraries, so the test runs offline.
replace (
	github.com/spf13/cobra => ./third_party/cobra
	github.com/urfave/cli/v2 => ./third_party/cliv2
)
