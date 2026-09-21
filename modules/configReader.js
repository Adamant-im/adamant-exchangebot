const fs = require('fs');
const path = require('path');

const jsonminify = require('jsonminify');

const { buildConfig, ConfigError } = require('./configSchema');

const ROOT_DIR = path.resolve(__dirname, '..');
const isDev = process.argv.includes('dev');
const isTestRun = Boolean(process.env.JEST_WORKER_ID);

/**
 * Chooses the config file to read.
 *
 * `EXCHANGEBOT_CONFIG` wins, so a single checkout can run several instances and so
 * tests can point at a fixture. Under Jest the bundled fixture is used rather than
 * the operator's own `config.test.jsonc`, which is gitignored and holds real
 * passphrases.
 *
 * @returns {string} Absolute path of the config file to read
 */
function resolveConfigFile() {
  if (process.env.EXCHANGEBOT_CONFIG) {
    return path.resolve(ROOT_DIR, process.env.EXCHANGEBOT_CONFIG);
  }

  if (isTestRun) {
    return path.join(ROOT_DIR, 'tests', 'fixtures', 'config.fixture.jsonc');
  }

  if (isDev) {
    return path.join(ROOT_DIR, 'config.test.jsonc');
  }

  const userConfig = path.join(ROOT_DIR, 'config.jsonc');

  return fs.existsSync(userConfig) ? userConfig : path.join(ROOT_DIR, 'config.default.jsonc');
}

/**
 * Reads and parses a JSONC config file.
 *
 * @param {string} configFile Absolute path of the config file
 * @returns {object} Parsed config contents
 * @throws {ConfigError} When the file cannot be read or is not valid JSON
 */
function readConfigFile(configFile) {
  let contents;

  try {
    contents = fs.readFileSync(configFile, 'utf-8');
  } catch (error) {
    throw new ConfigError(`Unable to read the config file '${configFile}'. ${error.message}`);
  }

  try {
    return JSON.parse(jsonminify(contents));
  } catch (error) {
    throw new ConfigError(`Config file '${configFile}' is not valid JSON. ${error.message}`);
  }
}

const configFile = resolveConfigFile();

let config;

try {
  config = buildConfig(readConfigFile(configFile), {
    version: require('../package.json').version,
    isDev,
  });

  if (!isTestRun) {
    console.info(
      `The bot ${config.address} successfully read the config file '${configFile}'${isDev ? ' (dev)' : ''}.`,
    );
  }
} catch (error) {
  console.error(`The bot's config is wrong. ${error.message} Cannot start the bot.`);
  process.exit(1);
}

module.exports = config;
