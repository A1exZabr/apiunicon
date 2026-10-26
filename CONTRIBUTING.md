# Contributing

Thank you for your interest in APIUniCon.

## Issues: yes. Pull requests: not yet.

For now we accept **issues only**. Bug reports, ideas, and requests for new services are all welcome; use the templates when you open an issue.

We do not accept pull requests at this stage. A pull request will be closed with a short note pointing here. This is not about the quality of your change: the project is young, its design still moves quickly, and we are not yet set up to review outside code and handle the rights to it. If you have a fix, open an issue that describes the problem and the fix in words; that helps just as much. We will update this file when that changes.

## Before you open an issue

- Search the existing issues first; add to an existing one rather than opening a duplicate.
- **Security problems go through [SECURITY.md](SECURITY.md)**, never into a public issue.
- Never paste API keys, tokens, passwords, key-entry or confirmation links, API responses, or customer data. Replace real values with placeholders such as `<token>`.
- For a bug, say what you did, what you expected, what happened instead, your operating system, and your Node.js version (`node --version`).
- For a new service, give the link to its official API documentation and what you want your assistant to do with it.

## Working on the code locally

You need Node.js 22.19 or later and npm.

```bash
npm ci
npm run check                  # strict TypeScript, no output files
npm test -- --maxWorkers=2     # the full test suite
npm run dev                    # the local service at http://127.0.0.1:3210
```

Tests never use your real data: each test file gets its own empty temporary home folder, so they never read or write `~/.apiunicon`.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

The code is available under the [PolyForm Shield License 1.0.0](LICENSE). The APIUniCon name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md).
