# Contributing

Tomat is in a **rapid-development phase**. During this period:

- All implementation is done by the maintainer ([@rzkyif](https://github.com/rzkyif)).
- **External pull requests will not be reviewed or accepted.** Please do not invest time in a PR - it will be closed unread.
- The architecture, schemas, and public surface are churning weekly. Anything submitted today could be invalidated by a refactor tomorrow.

This policy will relax once the project reaches a stable 1.0 release. Until then, the most valuable ways to help are:

1. **Test the app** and [**report bugs**](https://github.com/rzkyif/tomat/issues/new?template=bug-report.yml) as Issues, so each one can be tracked to resolution. Bugs may sit open for a while during rapid-dev - they're being read, not necessarily fixed on a schedule.
2. [**Suggest improvements**](https://github.com/rzkyif/tomat/discussions/new?category=improvement-suggestions) to existing features - UX friction, confusing copy, missing shortcuts, etc. These live in **Discussions** since they're wish-list items, not tracked work.
3. [**Request new features**](https://github.com/rzkyif/tomat/discussions/new?category=feature-requests) with a clear use-case. Also **Discussions** - the maintainer promotes one to an Issue when committing to build it.

Each template lives in [.github/](.github/).

## Security issues

Do **not** open a public discussion or issue for security-sensitive reports. See [SECURITY.md](SECURITY.md) for the private disclosure process.

## Running from source (for testing)

If you want to test pre-release builds or unreleased changes:

```bash
git clone https://github.com/rzkyif/tomat.git
cd tomat
bun install
bun run fetch
bun run dev
```

See [README.md](README.md#getting-started) for prerequisites and platform notes.

## Code of Conduct

Discussions are governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
