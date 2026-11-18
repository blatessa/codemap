// Package cobra is a signature-only stand-in for github.com/spf13/cobra.
package cobra

type Command struct {
	Use   string
	Short string
	Run   func(cmd *Command, args []string)
	RunE  func(cmd *Command, args []string) error
}

func (c *Command) AddCommand(cmds ...*Command) {}
func (c *Command) Execute() error              { return nil }
