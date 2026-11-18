package app

import "github.com/spf13/cobra"

var rootCmd = &cobra.Command{Use: "tool", Short: "The tool"}

var serveCmd = &cobra.Command{
	Use:   "serve [flags]",
	Short: "Run the server",
	RunE:  runServe,
}

func runServe(cmd *cobra.Command, args []string) error { Serve(); return nil }

// newDBCmd builds "db" and its subcommands; db itself only groups them.
func newDBCmd() *cobra.Command {
	db := &cobra.Command{Use: "db"}
	migrate := &cobra.Command{Use: "migrate", RunE: runMigrate}
	migrate.AddCommand(&cobra.Command{Use: "down", Run: func(cmd *cobra.Command, args []string) { Rollback() }})
	db.AddCommand(migrate)
	return db
}

func runMigrate(cmd *cobra.Command, args []string) error { Migrate(); return nil }

func init() {
	rootCmd.AddCommand(serveCmd, newDBCmd())
}

func ExecuteCobra() error { return rootCmd.Execute() }

func Serve()    {}
func Migrate()  {}
func Rollback() {}
