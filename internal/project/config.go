package project

// Config is .codemap/config.toml (documented for users in skills/codemap/SKILL.md;
// keep the two in step). Everything is optional; extractors
// apply their own defaults for zero values.
type Config struct {
	Exclude    []string       `toml:"exclude,omitempty" json:"exclude,omitempty"`
	Go         GoConfig       `toml:"go,omitempty" json:"go,omitempty"`
	TS         TSConfig       `toml:"ts,omitempty" json:"ts,omitempty"`
	Migrations []string       `toml:"migrations,omitempty" json:"migrations,omitempty"`
	External   ExternalConfig `toml:"external,omitempty" json:"external,omitempty"`
	Editor     string         `toml:"editor,omitempty" json:"editor,omitempty"`
}

// GoConfig configures the Go extractor.
type GoConfig struct {
	Jobs        []CallPattern `toml:"jobs,omitempty" json:"jobs,omitempty"`
	Subscribers []CallPattern `toml:"subscribers,omitempty" json:"subscribers,omitempty"`
	Publishers  []CallPattern `toml:"publishers,omitempty" json:"publishers,omitempty"`
	DBMethods   []string      `toml:"db_methods,omitempty" json:"db_methods,omitempty"`
}

// CallPattern identifies a call by its go/types-style callee name, for example
// "(*codemap/x/sched.Scheduler).Every" or "(*sched.Scheduler).Every" (package name
// only), and which arguments carry the name, topic, handler and value. Argument
// indexes are 0-based and count the receiver-less argument list.
type CallPattern struct {
	Call       string `toml:"call" json:"call"`
	NameArg    *int   `toml:"name_arg,omitempty" json:"name_arg,omitempty"`
	TopicArg   *int   `toml:"topic_arg,omitempty" json:"topic_arg,omitempty"`
	HandlerArg *int   `toml:"handler_arg,omitempty" json:"handler_arg,omitempty"`
	ValueArg   *int   `toml:"value_arg,omitempty" json:"value_arg,omitempty"`
}

// TSConfig configures the TypeScript extractor.
type TSConfig struct {
	Roots           []string `toml:"roots,omitempty" json:"roots,omitempty"`
	ModuleDepth     int      `toml:"module_depth,omitempty" json:"module_depth,omitempty"`
	HTTPClients     []string `toml:"http_clients,omitempty" json:"http_clients,omitempty"`
	BaseURLPrefixes []string `toml:"base_url_prefixes,omitempty" json:"base_url_prefixes,omitempty"`
	// Screens are globs of the files whose components are the app's screens
	// ("web/src/pages/**"). Unset, the screens are the router's pages or, with
	// none, the components nothing else renders.
	Screens []string `toml:"screens,omitempty" json:"screens,omitempty"`
}

// ExternalConfig extends external-service detection.
type ExternalConfig struct {
	Imports map[string]string `toml:"imports,omitempty" json:"imports,omitempty"` // import path prefix -> ext: id
}
