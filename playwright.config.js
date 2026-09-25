module.exports = {
  testDir: './tests',
  testMatch: ['review-ui.spec.js', 'broll-review-ui.spec.js', 'pult-ui.spec.js'],
  timeout: 30_000,
  use: {
    viewport: { width: 1280, height: 900 },
  },
  projects: [{
    name: 'chromium',
    use: { browserName: 'chromium', headless: true },
  }],
};
