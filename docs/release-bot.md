# Release bot

The release bot writes plain-English notes for the pull requests that landed on `main`, and credits the bot team.

- **thinker** wrote the spec.
- **builder**, **builder 2**, and **builder 3** build features. A `bot:` label or a `Bot:` line in the pull request wins. Otherwise the bot reads `.github/bot-team.json`: pull request number, then branch prefix. `cursor/release-bot` is **builder 3**.
- **tracker** reviews. A pull request comment that starts with `tracker review:` or `tracker re-review:` is quoted in the notes. A parenthetical before the colon is fine, as in `tracker review (addendum):` or `tracker re-review (PR #1):`.

This bot does not use the app's root `package.json` or `README.md`. The script and its npm script live in `.github/release/`.

Print the notes locally. This does not publish a release:

```bash
node .github/release/release-notes.mjs --dry-run
node .github/release/release-notes.mjs --dry-run --example
npm run release-notes --prefix .github/release -- --dry-run
```

The first command prints pull requests merged into `main` since the previous `v*` tag. A pull request merged into another branch is left out, unless its merge commit is already in `main`'s history. Nothing has merged to `main` yet, so the command reports an empty range.

`--example` prints the sample list in `examplePrs` inside `.github/bot-team.json` (currently #1-#4, including ones that are still open). That sample is in `CHANGELOG.md`. It is not a release. The real mapping can include other pull requests, such as #5, without changing the sample.

After pull request #1 lands, the app's `package.json` can grow one line so the same command works from the repo root:

```json
"release-notes": "node .github/release/release-notes.mjs"
```

Do not add that line before then. It would conflict with #1's `package.json`.

GitHub Actions (`.github/workflows/release-notes.yml`) runs `node .github/release/release-notes.mjs` with `GITHUB_TOKEN` only (`contents: write`, `pull-requests: read`):

- **Push a version tag (`v*`).** The bot prepends a section to `CHANGELOG.md`, commits it on `main` with `[skip release-notes]`, and publishes the GitHub Release for that tag. The skip marker applies only to branch pushes. Tagging the changelog commit still publishes the Release.
- **Push to `main`, or run the workflow by hand.** The bot does not commit. It writes the notes to the job summary and creates or updates a draft Release named `latest`. Leave that draft unpublished. A `v*` tag is what makes a public Release. The manual run has a dry-run switch that only prints the notes.
