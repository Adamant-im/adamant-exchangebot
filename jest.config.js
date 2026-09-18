/**
 * Jest configuration.
 *
 * The suite is unit-level: no test opens a network connection, talks to a real
 * MongoDB, or touches a real wallet. `modules/configReader` detects `JEST_WORKER_ID`
 * and loads `tests/fixtures/config.fixture.jsonc`, so a developer's own
 * `config.test.jsonc` and its passphrase are never read by a test run.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: ['app.js', 'helpers/**/*.js', 'modules/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  clearMocks: true,
  restoreMocks: true,
};
