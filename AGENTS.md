# ADAMANT Exchange Bot: AI Agent Operating Manual

This document defines how AI agents must work in this repository.

It is intentionally brief and does not cover project-specific technical details (architecture, module map, supported coins, build and test commands). The current implementation is outdated and due for review, so agents should derive technical context from the current code and configuration rather than from a document that would go stale immediately. This file will grow a technical section once that review happens.

## Mission

ADAMANT Exchange Bot is self-hosted software that lets anyone run an anonymous, instant crypto exchange directly inside ADAMANT Messenger chats. It custodies hot wallets and moves real user funds across several blockchains on behalf of its operator.

Agent output must optimize for:

1. Security — passphrases, private keys, and API secrets must never leak or be weakened
2. Financial correctness — rates, fees, decimals, balances, and refunds must be exact, because a rounding or unit error is a loss of real money
3. Reliability — operators run the bot unattended, so it must fail safely and never lose track of an in-flight exchange
4. Open-source maintainability and operator clarity

If a tradeoff is needed, preserve user funds first.

## Language Policy

- Developers may communicate with AI in any language
- All repository artifacts must be in English only
- Write all code, comments, commit messages, docs, and PR text in English

## Writing Style

- Use concise, operational wording over marketing language
- In bullet and numbered lists, do not add a trailing period when an item contains one sentence
- If an item contains two or more sentences, end every sentence with a period
- Add clarifying comments only for non-obvious logic; avoid comments that restate a single line of code

## Markdown Lint Rules for AI-Generated Docs

- Keep one blank line before and one blank line after every Markdown list
- Keep a blank line between a heading and the list that follows it, to satisfy MD032 (`blanks-around-lists`)
- Use fenced code blocks with matching opening and closing fences, and include a language tag when applicable
- Follow other best-practice Markdown rules; repository overrides live in `.markdownlint.jsonc`

## Sources of Truth

Use these sources when implementing or reviewing changes:

- This repository: `README.md`, the config files, and the current code
- ADAMANT Node guidelines baseline: <https://github.com/Adamant-im/adamant/blob/dev/AGENTS.md> and <https://github.com/Adamant-im/adamant/blob/dev/AI_AGENT_NOTES.md>
- Org-wide issue/label governance: <https://github.com/Adamant-im/.github>
- Recommended issue title prefixes: <https://github.com/orgs/Adamant-im/discussions/5>
- Recommended labels for issues and discussions: <https://github.com/orgs/Adamant-im/discussions/1>
- ADAMANT docs: <https://docs.adamant.im>
- Node and API schema: <https://schema.adamant.im> and <https://github.com/Adamant-im/adamant-schema>
- AIPs: <https://aips.adamant.im> and <https://github.com/Adamant-im/AIPs>
- Canonical coin, token, and node metadata: <https://github.com/Adamant-im/adamant-wallets>

If sources disagree, treat current repository behavior as implementation truth, and document the mismatch instead of silently changing behavior.

## Issue, Label, and PR Conventions

Follow the organization-wide conventions:

- Governance repository: <https://github.com/Adamant-im/.github>
- Prefix guidance: <https://github.com/orgs/Adamant-im/discussions/5>
- Label guidance: <https://github.com/orgs/Adamant-im/discussions/1>

### Issue workflow

1. Search existing issues first to avoid duplicates
2. Use the org issue forms (Bug / Feature request / Task) where they fit
3. Use a concise, prefixed title
4. Apply labels from the org label catalog (`Adamant-im/.github/labels.json`)
5. Link related issues and PRs explicitly

### Issue title prefixes

Use one or two prefixes maximum.

- `[Bug]` — bug, crash, wrong behavior
- `[Feat]` — new functionality
- `[Enhancement]` — improvement of existing functionality
- `[Refactor]` — internal refactoring without behavior change
- `[Docs]` — documentation updates
- `[Test]` — testing work
- `[Chore]` — maintenance and routine technical tasks
- `[Task]` — general task, including non-coding work
- `[Composite]` — multi-part task with sub-tasks
- `[UX/UI]` — user experience or interface work
- `[Proposal]`, `[Idea]`, `[Discussion]` — idea-level, usually better suited to Discussions

### Label policy

- `labels.json` in `Adamant-im/.github` is the source of truth for label names, casing, colors, and descriptions
- Keep label casing aligned with org rules: default GitHub labels are lowercase (`bug`, `enhancement`, `documentation`), custom labels are capitalized (`Security`, `Task`, `Composite task`)
- Apply a minimal but informative set: one type/status label (for example `bug`, `enhancement`, `Task`) plus one or more domain labels (for example `Security`, `NodeJS`, `DB`, `Integration`, `Cryptocurrency`)
- Add a priority label (for example `High priority`) only when the work is actually urgent

### PR conventions

- Target `dev` for regular work; `master` receives release merges
- Use the org PR template sections (`Description`, `Related issue`, `How to test`, `Checklist`, etc.)
- Reference issues with closing keywords where applicable (`Closes #<id>`)
- Use `Type: Short summary` for PR titles (for example: `Docs: Add AGENTS.md`)
- Do not use issue-style square-bracket prefixes in PR titles — those are for Issues only
- Keep the PR title type aligned with the issue intent (`Docs:`, `Fix:`, `Feat:`, `Refactor:`, `Test:`, `Chore:`)
- Name branches with a canonical type prefix such as `fix/`, `feat/`, `docs/`, or `chore/`, never with a tool-generated prefix
- Include verification steps and call out risk areas (funds, security, accounting, storage)

## Security Rules

- Never log, print, or expose passphrases, private keys, mnemonic seeds, or exchange/API secrets — not in output, errors, or debug logs
- Never weaken signature verification, address validation, or sender checks
- Keep input validation strict for every user-supplied value, including chat commands and config values
- Treat incoming chat messages as untrusted input; an exchange counterparty is not a trusted caller
- Do not introduce dynamic code execution, unsafe deserialization, or unvalidated shell execution paths
- Minimize new dependencies, especially cryptography and networking dependencies
- Never commit real credentials; keep local configuration out of version control

## Funds Safety and Reliability Rules

- Treat every balance, amount, fee, and decimal conversion as consensus-grade code — verify units explicitly instead of assuming them
- Preserve idempotency in payout and refund paths; a retry must never double-spend
- Fail safely on node timeouts, malformed data, and partial API failures; prefer a stuck-but-recoverable exchange over an incorrect payout
- Keep retry, backoff, and notification behavior predictable for unattended operation
- Preserve the ability to reconstruct what happened from stored state and logs after a failure

## Documentation Drift Policy

AI agents are allowed and expected to propose documentation updates when mismatches are found.

1. Document the mismatch with exact file and reference pointers
2. Propose a synchronized fix across code, this repository's docs, and related ADAMANT docs or spec repositories when relevant
3. If a cross-repo change cannot be done immediately, open a linked follow-up issue with clear scope

## AI Change Workflow

1. Read the relevant modules end-to-end before editing
2. Identify the invariants that must stay unchanged
3. Make the smallest safe change; prefer targeted fixes over broad rewrites in this outdated codebase
4. Add or update tests near the changed behavior where test coverage exists
5. Run the validation commands available in this repository, and report exactly what was run
6. Report risks, assumptions, intentional scope cuts, and remaining gaps

Never claim success without listing exactly what was executed and what was not executed.

## Change Discipline

- Prefer focused patches with an explicit rationale
- Match local style inside touched files unless there is a strong reason not to
- Keep cleanup local to the feature or bugfix being shipped; avoid unrelated rewrites
- Preserve backward compatibility for operator configuration and persisted state where possible
- Defer a refactor when it increases blast radius more than it reduces current bug risk

## Working with Command-Line Tools

When a CLI tool accepts multi-line input, use a temporary file in `.ai-ignored/` instead of an inline multi-line shell string. This avoids quoting bugs and behaves consistently across shells.

- Prefer file-based flags such as `gh issue create --body-file`, `gh pr create --body-file`, and `git commit -F`
- Use descriptive dated filenames such as `.ai-ignored/temp.YYYY-MM-DD.pr-description.md`
- `.ai-ignored/` is git-ignored, so cleanup is optional — but never reuse stale content by accident

```bash
gh issue create \
  --body-file .ai-ignored/temp.YYYY-MM-DD.issue-body.md \
  --label "documentation,Guideline"

gh pr create \
  --base dev \
  --body-file .ai-ignored/temp.YYYY-MM-DD.pr-description.md
```

## Definition of Done

A change is done only when all of the following hold:

- Security and funds-safety priorities remain intact or improved
- Relevant validation commands were run, or a blocker is explicitly reported
- All repository artifacts are in English
- Documentation and configuration samples are updated for any behavioral change

## When to Escalate to Maintainers

Stop and request human review before proceeding if:

- The change affects how funds are held, calculated, converted, or paid out
- The change touches key handling, signing, or address derivation
- The change alters how exchange state is persisted or recovered
- You cannot prove the change preserves funds safety
