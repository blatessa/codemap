module orm

go 1.23

require (
	github.com/uptrace/bun v1.0.0
	gorm.io/gorm v1.0.0
	xorm.io/xorm v1.0.0
)

// Signature-only stand-ins for the ORMs, so the test runs offline.
replace (
	github.com/uptrace/bun => ./third_party/bun
	gorm.io/gorm => ./third_party/gorm
	xorm.io/xorm => ./third_party/xorm
)
