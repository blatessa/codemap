package goext

import (
	"go/types"
	"regexp"
	"sort"
	"strings"

	"codemap/internal/project"
)

// extService maps an import path prefix to an external service node.
type extService struct {
	prefix string // import path prefix, matched on path-element boundaries
	id     string // ext: ID; with perService, "ext:<id>-<next path element>"
	label  string
	// perService makes each package directly under prefix its own service, as in
	// github.com/aws/aws-sdk-go-v2/service/s3 → ext:aws-s3.
	perService bool
}

// builtinExternal is the built-in SDK table (PLAN.md §5.5). Labels are the
// service's API host where it has one. config.external.imports extends and
// overrides it.
var builtinExternal = []extService{
	{prefix: "github.com/stripe/stripe-go", id: "ext:stripe", label: "api.stripe.com"},
	{prefix: "github.com/aws/aws-sdk-go-v2/service", id: "ext:aws", label: "AWS", perService: true},
	{prefix: "github.com/aws/aws-sdk-go/service", id: "ext:aws", label: "AWS", perService: true},
	{prefix: "github.com/keighl/postmark", id: "ext:postmark", label: "api.postmarkapp.com"},
	{prefix: "github.com/mrz1836/postmark", id: "ext:postmark", label: "api.postmarkapp.com"},
	{prefix: "github.com/twilio/twilio-go", id: "ext:twilio", label: "api.twilio.com"},
	{prefix: "github.com/sendgrid/sendgrid-go", id: "ext:sendgrid", label: "api.sendgrid.com"},
	{prefix: "github.com/mailgun/mailgun-go", id: "ext:mailgun", label: "api.mailgun.net"},
	{prefix: "github.com/resend/resend-go", id: "ext:resend", label: "api.resend.com"},
	{prefix: "github.com/slack-go/slack", id: "ext:slack", label: "slack.com"},
	{prefix: "github.com/sashabaranov/go-openai", id: "ext:openai", label: "api.openai.com"},
	{prefix: "github.com/openai/openai-go", id: "ext:openai", label: "api.openai.com"},
	{prefix: "github.com/anthropics/anthropic-sdk-go", id: "ext:anthropic", label: "api.anthropic.com"},
	{prefix: "github.com/google/go-github", id: "ext:github", label: "api.github.com"},
	{prefix: "github.com/plaid/plaid-go", id: "ext:plaid", label: "plaid.com"},
	{prefix: "github.com/braintree-go/braintree-go", id: "ext:braintree", label: "braintreegateway.com"},
	{prefix: "github.com/getsentry/sentry-go", id: "ext:sentry", label: "sentry.io"},
	{prefix: "github.com/DataDog/datadog-go", id: "ext:datadog", label: "datadoghq.com"},
	{prefix: "github.com/algolia/algoliasearch-client-go", id: "ext:algolia", label: "algolia.net"},
	{prefix: "github.com/meilisearch/meilisearch-go", id: "ext:meilisearch", label: "meilisearch"},
	{prefix: "github.com/elastic/go-elasticsearch", id: "ext:elasticsearch", label: "elasticsearch"},
	{prefix: "github.com/olivere/elastic", id: "ext:elasticsearch", label: "elasticsearch"},
	{prefix: "github.com/redis/go-redis", id: "ext:redis", label: "redis"},
	{prefix: "github.com/go-redis/redis", id: "ext:redis", label: "redis"},
	{prefix: "github.com/gomodule/redigo", id: "ext:redis", label: "redis"},
	{prefix: "go.mongodb.org/mongo-driver", id: "ext:mongodb", label: "mongodb"},
	{prefix: "github.com/segmentio/kafka-go", id: "ext:kafka", label: "kafka"},
	{prefix: "github.com/IBM/sarama", id: "ext:kafka", label: "kafka"},
	{prefix: "github.com/Shopify/sarama", id: "ext:kafka", label: "kafka"},
	{prefix: "github.com/confluentinc/confluent-kafka-go", id: "ext:kafka", label: "kafka"},
	{prefix: "github.com/nats-io/nats.go", id: "ext:nats", label: "nats"},
	{prefix: "github.com/rabbitmq/amqp091-go", id: "ext:rabbitmq", label: "rabbitmq"},
	{prefix: "github.com/streadway/amqp", id: "ext:rabbitmq", label: "rabbitmq"},
	{prefix: "cloud.google.com/go/storage", id: "ext:gcs", label: "storage.googleapis.com"},
	{prefix: "cloud.google.com/go/pubsub", id: "ext:gcp-pubsub", label: "pubsub.googleapis.com"},
	{prefix: "cloud.google.com/go/bigquery", id: "ext:bigquery", label: "bigquery.googleapis.com"},
	{prefix: "firebase.google.com/go", id: "ext:firebase", label: "firebase"},
	{prefix: "github.com/minio/minio-go", id: "ext:s3", label: "s3"},
	{prefix: "github.com/hashicorp/vault/api", id: "ext:vault", label: "vault"},
	{prefix: "github.com/launchdarkly/go-server-sdk", id: "ext:launchdarkly", label: "launchdarkly"},
	{prefix: "github.com/auth0/go-auth0", id: "ext:auth0", label: "auth0"},
	{prefix: "github.com/okta/okta-sdk-golang", id: "ext:okta", label: "okta"},
	{prefix: "github.com/pusher/pusher-http-go", id: "ext:pusher", label: "pusher"},
}

type extTable struct {
	config  []extService // from config, longest prefix first
	builtin []extService // longest prefix first
}

func newExtTable(cfg project.Config) *extTable {
	t := &extTable{builtin: append([]extService(nil), builtinExternal...)}
	for prefix, id := range cfg.External.Imports {
		if !strings.HasPrefix(id, "ext:") {
			id = "ext:" + id
		}
		t.config = append(t.config, extService{prefix: prefix, id: id, label: strings.TrimPrefix(id, "ext:")})
	}
	byLen := func(s []extService) {
		sort.SliceStable(s, func(i, j int) bool {
			if len(s[i].prefix) != len(s[j].prefix) {
				return len(s[i].prefix) > len(s[j].prefix)
			}
			return s[i].prefix < s[j].prefix
		})
	}
	byLen(t.config)
	byLen(t.builtin)
	return t
}

var majorVersion = regexp.MustCompile(`^v[0-9]+$`)

// extMatch is a resolved external service for a package.
type extMatch struct {
	id, label string
	root      string // the import path the service's SDK lives at
}

// lookup returns the external service an import path belongs to.
func (t *extTable) lookup(pkgPath string) (extMatch, bool) {
	for _, list := range [][]extService{t.config, t.builtin} {
		for _, s := range list {
			if pkgPath != s.prefix && !strings.HasPrefix(pkgPath, s.prefix+"/") {
				continue
			}
			m := extMatch{id: s.id, label: s.label, root: s.prefix}
			rest := strings.Split(strings.TrimPrefix(strings.TrimPrefix(pkgPath, s.prefix), "/"), "/")
			if s.perService {
				if rest[0] == "" {
					continue
				}
				m.id += "-" + rest[0]
				m.label += " " + rest[0]
				m.root += "/" + rest[0]
				rest = rest[1:]
			}
			if len(rest) > 0 && majorVersion.MatchString(rest[0]) {
				m.root += "/" + rest[0]
			}
			return m, true
		}
	}
	return extMatch{}, false
}

// isPointerHelper reports whether f looks like an SDK's value/pointer helper
// (stripe.String, aws.Int64, aws.StringValue): one basic parameter and one
// result that's a pointer to it, or the reverse. Calls to these aren't
// interesting interactions with the service.
func isPointerHelper(f *types.Func) bool {
	sig := f.Signature()
	if sig.Recv() != nil || sig.Params().Len() != 1 || sig.Results().Len() != 1 {
		return false
	}
	p, r := sig.Params().At(0).Type(), sig.Results().At(0).Type()
	isBasic := func(t types.Type) bool { _, ok := t.Underlying().(*types.Basic); return ok }
	isPtrBasic := func(t types.Type) bool {
		pt, ok := t.Underlying().(*types.Pointer)
		return ok && isBasic(pt.Elem())
	}
	return isBasic(p) && isPtrBasic(r) || isPtrBasic(p) && isBasic(r)
}
