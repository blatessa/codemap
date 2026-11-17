package project

// Config is .codemap/config.yaml (PLAN.md §5.7). Everything is optional; extractors
// apply their own defaults for zero values.
type Config struct {
	Exclude    []string       `yaml:"exclude,omitempty" json:"exclude,omitempty"`
	Go         GoConfig       `yaml:"go,omitempty" json:"go,omitempty"`
	TS         TSConfig       `yaml:"ts,omitempty" json:"ts,omitempty"`
	Migrations []string       `yaml:"migrations,omitempty" json:"migrations,omitempty"`
	External   ExternalConfig `yaml:"external,omitempty" json:"external,omitempty"`
	Editor     string         `yaml:"editor,omitempty" json:"editor,omitempty"`
}

// GoConfig configures the Go extractor.
type GoConfig struct {
	Jobs        []CallPattern `yaml:"jobs,omitempty" json:"jobs,omitempty"`
	Subscribers []CallPattern `yaml:"subscribers,omitempty" json:"subscribers,omitempty"`
	Publishers  []CallPattern `yaml:"publishers,omitempty" json:"publishers,omitempty"`
	DBMethods   []string      `yaml:"db_methods,omitempty" json:"db_methods,omitempty"`
}

// CallPattern identifies a call by its go/types-style callee name, for example
// "(*codemap/x/sched.Scheduler).Every" or "(*sched.Scheduler).Every" (package name
// only), and which arguments carry the name, topic, handler and value. Argument
// indexes are 0-based and count the receiver-less argument list.
type CallPattern struct {
	Call       string `yaml:"call" json:"call"`
	NameArg    *int   `yaml:"name_arg,omitempty" json:"name_arg,omitempty"`
	TopicArg   *int   `yaml:"topic_arg,omitempty" json:"topic_arg,omitempty"`
	HandlerArg *int   `yaml:"handler_arg,omitempty" json:"handler_arg,omitempty"`
	ValueArg   *int   `yaml:"value_arg,omitempty" json:"value_arg,omitempty"`
}

// TSConfig configures the TypeScript extractor.
type TSConfig struct {
	Roots           []string `yaml:"roots,omitempty" json:"roots,omitempty"`
	ModuleDepth     int      `yaml:"module_depth,omitempty" json:"module_depth,omitempty"`
	HTTPClients     []string `yaml:"http_clients,omitempty" json:"http_clients,omitempty"`
	BaseURLPrefixes []string `yaml:"base_url_prefixes,omitempty" json:"base_url_prefixes,omitempty"`
}

// ExternalConfig extends external-service detection.
type ExternalConfig struct {
	Imports map[string]string `yaml:"imports,omitempty" json:"imports,omitempty"` // import path prefix -> ext: id
}
