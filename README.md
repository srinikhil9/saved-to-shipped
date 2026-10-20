# saved-to-shipped

## Release bot

The release bot writes plain-English notes for the pull requests that landed, and credits the bot team.

- **thinker** wrote the spec.
- **builder**, **builder 2**, and **builder 3** build features. A `bot:` label or a `Bot:` line in the pull request wins. Otherwise the bot reads `.github/bot-team.json`: pull request number, then branch prefix.
- **tracker** reviews. A pull request comment that starts with `tracker review:` or `tracker re-review:` is quoted in the notes.

Print the notes locally. This does not publish a release:

```bash
npm run release-notes -- --dry-run
npm run release-notes -- --dry-run --example
```

The first command prints pull requests merged since the previous `v*` tag. None have merged yet, so it reports an empty range. `--example` prints sample notes for the pull requests listed in `.github/bot-team.json` (currently #1-#4, including ones that are still open). That sample is already in `CHANGELOG.md`. It is not a release.

GitHub Actions (`.github/workflows/release-notes.yml`) runs this script with `GITHUB_TOKEN` only (`contents: write`, `pull-requests: read`):

- **Push a version tag (`v*`).** The bot prepends a section to `CHANGELOG.md`, commits it on `main` with `[skip release-notes]`, and publishes the GitHub Release for that tag.
- **Push to `main`, or run the workflow by hand.** The bot does not commit. It writes the notes to the job summary and creates or updates a **draft** Release named `latest`. Leave that draft unpublished. A `v*` tag is the real release. The manual run has a dry-run switch that only prints the notes.
