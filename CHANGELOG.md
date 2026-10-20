# Changelog

The release bot writes this file. Pushing a version tag (v*) adds a section here and publishes a GitHub Release. A push to main does not change this file. It updates the draft Release named latest and the Actions job summary.

## Example: PRs #1-#4

Sample notes covering pull requests #1, #2, #3, and #4. They were open when these notes were written, so this section is not a GitHub Release.

### Changes

- [#1 Paste an X post and get a sorted card in the feed](https://github.com/srinikhil9/saved-to-shipped/pull/1) — The card shows up as queued, then the pipeline fills in author, text, kind, and summary.
- [#2 Run repo saves and cache the Scrapling scrape](https://github.com/srinikhil9/saved-to-shipped/pull/2) — actOnRepo clones a GitHub repo into a fresh temp dir, installs it, runs a smoke scrape, and stores stdout, a screenshot, and action_result_json on the save.
- [#3 Add a one-line profile-based why_you for each save](https://github.com/srinikhil9/saved-to-shipped/pull/3) — Each save gets a one-line why_you from data/profile.json as soon as it is sorted, on both the Grok sort path and the no-key path.
- [#4 Step 4: paper/idea actions](https://github.com/srinikhil9/saved-to-shipped/pull/4) — Paper and idea saves write a one-page SPEC.md plus a starter folder, zip both, and link the zip from the feed card and the detail page.

### Bot team

- **thinker** wrote the spec.
- **builder** built #1 Paste an X post and get a sorted card in the feed.
- **builder 2** built #2 Run repo saves and cache the Scrapling scrape.
- **builder 3** built #3 Add a one-line profile-based why_you for each save and #4 Step 4: paper/idea actions.
- **tracker** reviewed #1: needs fixes; re-review: passes, with 1 follow-up fix; re-review: passes.
- **tracker** reviewed #2: needs fixes; re-review: still needs fixes (3).
- **tracker** reviewed #3: needs fixes (small ones); re-review: still needs fixes (2).
- **tracker** reviewed #4: passes; re-review: still needs fixes (2).

_Release bot, 2026-10-20._
