package main

import (
	"log"

	"github.com/egoist/mygo"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("reading %s: %v", configPath(), err)
	}
	// Resolve the login shell's PATH ahead of the first command.
	go userPath()

	// Bound as "Hub": `mygo generate` turns its methods into typed
	// TypeScript functions in src/mygo.ts.
	mygo.Bind(&Hub{cfg: cfg})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:           "Skills Hub",
			Width:           1180,
			Height:          760,
			MinWidth:        860,
			MinHeight:       520,
			BackgroundColor: "light-dark(#f6f6f9, #17171c)", // the page's --bg in src/style.css
			// Opens where the user left it last time.
			StateKey: "main",
			// The frontend: devUrl during `mygo dev`, frontendDist
			// embedded by `mygo build` otherwise (see mygo.config.ts).
			URL: "/",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
