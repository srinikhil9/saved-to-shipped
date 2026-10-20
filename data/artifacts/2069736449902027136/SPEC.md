# SPEC: Loop Engineering for the scrape → recommend pipeline

## Context

Srinikhil is building a startup that scrapes users' social media data to recommend niche consumer products from YC / a16z startups.

The saved post is Loop Engineering: stop prompting the agent, and build the system that prompts it. One turn is five moves. Schedule → Discover → Build → Verify → Repeat. An agent grading its own work always praises it, so the verifier is a second pass that assumes the work is broken.

## Apply it here

Posts come in and product recommendations go out. That is already a loop. It should run without someone pasting the next task into a chat.

- **Discover.** The loop finds its own work: failed scrapes, users with new posts, and YC / a16z companies added since the last tick. It is not handed a list.
- **Handoff.** Each task gets an isolated worktree (its own job directory) so a scrape for one user cannot collide with a catalog write for another company.
- **Build.** One task only. Draft the recommendation, then stop. The draft is a file, not a paragraph left in the context window.
- **Verify.** A second agent is told the draft is broken. The product has to still exist, the company has to be a real YC or a16z company, and the niche has to be backed by a quote from the user's posts. If any check fails, the verdict is no.
- **Schedule.** A timer wakes the next turn. That wake is what makes it a loop. Persistence is the same rule as the handoff: results go to disk (`loop/state/`, and the product database), never only into a window that will be flushed.

## Saved to Shipped is this loop

Saved to Shipped is the same five moves, one level up. A pasted post is discovered work. Sort and act are the build. The reviewer that assumes the change is wrong is the verifier. `data/artifacts/` is the persistence. The next paste, or a rerun, is the schedule. Shipping the scrape pipeline means pointing that loop at users and startups instead of at bookmarks.

## Done

- `loop/schedule.mjs` writes a tick and names the next move.
- `loop/discover.mjs` writes `loop/state/work.json` with scrape, catalog, and recommendation tasks.
- `loop/build.mjs` writes one draft to `loop/state/draft.json`.
- `loop/verify.mjs` assumes that draft is broken and writes `loop/state/verdict.json`.
- A recommendation the loop stands behind can be rebuilt from those files alone.

## Source

https://x.com/0xCodez/status/2069736449902027136
Paper: https://drive.google.com/file/d/1qzKI4DKnyHRpXK1J3ATPqwaqLc0iNu-M/view?usp=sharing
