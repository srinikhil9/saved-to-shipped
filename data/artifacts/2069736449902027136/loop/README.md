# Loop

Stubs for Schedule → Discover → Build → Verify on the scrape → recommend pipeline. The spec is `../SPEC.md`.

From this folder:

    node schedule.mjs
    node discover.mjs
    node build.mjs
    node verify.mjs

`verify.mjs` assumes the draft is broken. The draft from `build.mjs` names a product and a batch, and it leaves the user's post empty, so the verdict is no. That no is the point of the second agent.

Each script writes `state/`. Those files are the memory.
