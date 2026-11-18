package main

import (
	"os"

	"commands/app"
)

func main() {
	_ = app.ExecuteCobra()
	_ = app.RunUrfave(os.Args)
	_ = app.Dispatch(os.Args[1], os.Args[2:])
}
