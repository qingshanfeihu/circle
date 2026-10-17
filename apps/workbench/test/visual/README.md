# Desktop appearance regression

Run `npm --prefix apps/workbench run test:visual` after installing the browser pinned by Playwright:

```sh
node apps/workbench/node_modules/playwright/cli.js install chromium
```

The test reuses the existing main-window, panel, Git, GitHub, debugger, browser diagnostics and recovered-input scenarios. They load the application's styles. Both languages, both themes and narrow/wide viewports are captured. These renderer fixtures complement the real Electron interface and developer journeys; they do not replace them.

Differences in more than 0.05% of an image's pixels fail the test (text anti-aliasing alone moves up to about a hundred pixels between runs on the same runner) and produce expected, actual and diff images in `apps/workbench/artifacts/visual/`. The HTML report includes every captured image. Apple silicon CI runs the comparison without updating snapshots.

Generate local review candidates with `npm --prefix apps/workbench run test:visual -- --update-snapshots=all`. Review the images before including baseline changes in a PR. A successful comparison against newly generated images is not visual approval. Do not merge changed baselines until the owner confirms their appearance. CI never updates them.

Baselines are platform-specific. The current 193-image set is what the Apple silicon CI runner (macOS 15) draws; it was reviewed on macOS 27.0.1, which anti-aliases text slightly differently, so a local comparison on a newer macOS can differ by a few hundred pixels per image. Take baselines from the CI run's `-actual.png` images, not from a local machine. Differences after a system font change still need review, not automatic acceptance. Use the bundled Chromium for consistent rendering; an alternate browser channel requires its own baseline review.
