# Contributing to ADAMANT Exchange Bot

Thank you for improving `adamant-exchangebot`. This bot custodies hot wallets and moves real user funds, so changes should protect, in this order: user funds, exchange-accounting correctness, node reliability, and operator clarity.

## Before you start

- Search [existing issues](https://github.com/Adamant-im/adamant-exchangebot/issues) before opening a new one.
- Use a concise issue prefix such as `[Bug]`, `[Feat]`, `[Enhancement]`, `[Refactor]`, `[Docs]`, `[Test]`, or `[Chore]`.
- Base work on `dev` and target `dev` in pull requests. `master` receives release merges.
- Never commit a real `config.jsonc`, a real passphrase, a private key, or a log file. `config.jsonc`, `config.test.jsonc` and `logs/` are gitignored — keep it that way. Redact `passPhrase` and `slack` before pasting config into an issue.

All repository artifacts — code, comments, documentation, commits, issues, and pull requests — must be written in English.

## Development setup

Use Node.js 22.13 or newer and npm 10 or newer; `engines` in `package.json` enforces both.

```sh
git clone https://github.com/Adamant-im/adamant-exchangebot.git
cd adamant-exchangebot
git switch dev
npm ci
cp config.default.jsonc config.jsonc
```

Create a dedicated branch with a canonical type prefix:

```sh
git switch -c feat/short-description
```

MongoDB is needed to _run_ the bot, not to run the tests. Use a throwaway passphrase that controls no funds for local development, and never point a development instance at a production passphrase.

`npm run start:dev` reads `config.test.jsonc`, which is gitignored — it is your own file, not one the repository provides.

## Validation

There is no build step; the project is CommonJS and runs directly.

```sh
npm run lint
npm run format:check
npm test
```

Run all three before opening a pull request, and report in the description exactly which commands you ran and which you could not.

`npm run lint:fix` and `npm run format` apply the automatic fixes.

## Tests

The suite uses Jest 30 and lives in `tests/`:

```text
tests/
├── fixtures/   # test config, sample payments, UTXO builders
├── helpers/    # utils, const, log, notify, messenger, dbModel, scheduler, nodeClient, phrases
├── cryptos/    # rate and conversion maths, and the per-coin adapters
└── modules/    # config validation and the exchange pipeline
```

Rules for the suite:

- No test may open a network connection, talk to a real MongoDB, or use a real wallet. Mock `axios`, the `adamant-api` client, and `modules/DB`.
- Tests never load your own config. `modules/configReader` detects `JEST_WORKER_ID` and reads `tests/fixtures/config.fixture.jsonc`, whose passphrase controls no funds.
- Every bug fix ships with a regression test.
- Every new branch in the exchange pipeline ships with a test for that branch.

Run a single file while developing:

```sh
npx jest tests/cryptos/exchanger.test.js
npm run test:coverage
```

## Project structure

- `app.js` — entry point: waits for the database and the ADAMANT node, reconciles interrupted payouts, subscribes to the socket, and starts the workers
- `modules/api.js` — the shared `adamant-api` client and socket
- `modules/configReader.js` — resolves and loads the config file; `modules/configSchema.js` holds the pure validation
- `modules/DB.js`, `helpers/dbModel.js` — the MongoDB connection and the thin document model over `systems`, `incomingtxs` and `payments`
- `modules/Store.js` — the last processed ADAMANT block height
- `modules/checkerTransactions.js` — REST polling for new ADAMANT transactions
- `modules/incomingTxsParser.js` — classifies each message and routes it
- `modules/commandTxs.js` — `/help`, `/rates`, `/calc`, `/test`, `/balances`, `/version`
- `modules/exchangeTxs.js` — basic validation, limits, pricing, and the quote
- `modules/deepExchangeValidator.js` — blockchain-level verification of the incoming transfer
- `modules/confirmationsCounter.js` — confirmation tracking and InstantSend handling
- `modules/exchangePayer.js` — outgoing exchange payments
- `modules/sendBack.js` — refunds
- `modules/sentTxChecker.js` — confirmation of outgoing transfers and closing the deal
- `modules/unknownTxs.js` — replies to messages the bot cannot interpret
- `helpers/` — `const`, `log`, `notify`, `messenger`, `scheduler`, `utils`, `dbModel`, `phrases`
- `helpers/cryptos/` — `exchanger` (rates, conversions, coin registry), `nodeClient` (node failover), `baseCoin`, and the per-coin adapters
- `config.default.jsonc` — the shipped config and its documentation

Every coin adapter implements the same narrow interface — `getBalance`, `getLastBlockHeight`, `getTransaction`, `send`, `isValidAddress`, `FEE` — so the pipeline never talks to a node directly. Keep it that way: it is what will make the move to a wallet SDK a local change.

## Funds-safety review rules

A change needs extra scrutiny, and must say so in the pull request description, when it touches any of:

- amount, fee, decimal or unit conversion — `fromSat`, `toSat`, `convertCryptos`, `getRate`, any `FEE` getter
- the payout and refund paths in `exchangePayer.js` and `sendBack.js` — a retry must never double-spend
- incoming-transfer validation in `deepExchangeValidator.js` — never weaken the sender, recipient, amount or timestamp checks
- confirmation counting and `min_confirmations` handling
- key derivation, signing or address handling in `helpers/cryptos/`
- persisted payment state or its recovery after a restart

For such pull requests:

1. State the invariant you believe the change preserves, and how you tested it
2. Prefer a stuck-but-recoverable exchange over an incorrect payout
3. Never log a passphrase, private key or seed — not in errors, not at debug level
4. Test with dust amounts on mainnet, or on a testnet, before requesting review, and say which
5. Expect two-person review

## Code style

- ESLint flat config (`eslint.config.js`) and Prettier 3, with two-space indentation
- CommonJS `require`, not ESM
- JSDoc on every exported function, and on anything whose parameters are not obvious from its name
- Comment non-obvious logic only; do not restate a single line of code
- User-facing chat strings are English, free of obscenity, and make no price predictions — the bot quotes rates and holds funds, so a price claim reads as investment advice

## Pull requests

- Use a title in `Type: Short summary` form, for example `Fix: Count the network fee before refunding`. Square-bracket prefixes are for issues, not pull requests.
- Name branches `fix/`, `feat/`, `docs/`, `chore/`, `refactor/` or `test/`.
- Link the related issue with a closing keyword, for example `Closes #55`.
- Include a "How to test" section, and call out the risk areas: funds, security, accounting, storage.
- Update `README.md` and `config.default.jsonc` in the same pull request as any behavioural or configuration change.
- Keep dependency additions minimal, and explain any new cryptography or networking dependency.

Small reviewable commits are welcome; maintainers may squash them when merging.

## Reporting a vulnerability

Report anything touching keys, signing, validation bypass or balance accounting privately to <devs@adamant.im>. Do not open a public issue for it.
