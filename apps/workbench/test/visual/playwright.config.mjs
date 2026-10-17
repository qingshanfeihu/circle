import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'appearance.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/baselines/{platform}/{testName}/{arg}{ext}',
  outputDir: '../../artifacts/visual/results',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../artifacts/visual/report', open: 'never' }],
  ],
  // Text anti-aliasing differs by up to about a hundred pixels between two runs
  // on the same runner; a moved or restyled control changes far more than this.
  expect: { toMatchSnapshot: { threshold: 0.1, maxDiffPixelRatio: 0.0005 } },
});
