const KINDS = new Set(["repo", "tool", "paper", "idea", "event", "other"]);

const DEFAULT_SLOTS = {
  pipeline: "social-data scraping pipeline",
  use: "pull user posts at scale for product recommendations",
  agents: "scrape-and-recommend agents",
  product: "Saved to Shipped",
  memory: "saved posts, founders, and YC/a16z products",
  wiki: "living wiki",
  reader: "recommender",
};

/**
 * One line for this save, from data/profile.json.
 * A template per kind, overridden by a few keyword hits.
 */
export function whyYou(save, profile = {}) {
  const kind = KINDS.has(save?.kind) ? save.kind : "other";
  const blob = `${save?.text || ""}\n${save?.summary || ""}`;
  const slots = { ...DEFAULT_SLOTS, ...(profile.why || {}) };
  const hit = keywordLine(kind, blob, slots);
  if (hit) return hit;
  return template(kind, profile);
}

export function backfillWhyYou(db, profile) {
  const rows = db
    .prepare("SELECT * FROM saves WHERE kind IS NOT NULL AND (why_you IS NULL OR why_you = '')")
    .all();
  if (!rows.length) return 0;
  const update = db.prepare("UPDATE saves SET why_you = @why_you WHERE id = @id");
  const write = db.transaction((pending) => {
    for (const row of pending) update.run({ id: row.id, why_you: whyYou(row, profile) });
  });
  write(rows);
  return rows.length;
}

function keywordLine(kind, blob, slots) {
  if ((kind === "repo" || kind === "tool") && /\bscrap/i.test(blob)) {
    return `Drop-in for your ${slots.pipeline}: use it to ${slots.use}.`;
  }
  if (kind === "paper" && /\bloop\b/i.test(blob)) {
    return `A blueprint for running your ${slots.agents} as a self-verifying loop; ${slots.product} is one.`;
  }
  if (kind === "idea" && /second brain|karpathy|living wiki/i.test(blob)) {
    return `Turn your ${slots.memory} into a ${slots.wiki} your ${slots.reader} can draw on.`;
  }
  return null;
}

function template(kind, profile) {
  const building = profile.building || profile.summary || "what you are shipping";
  if (kind === "repo") return `A repo to use while you build ${building}.`;
  if (kind === "tool") return `A tool to put in front of ${building}.`;
  if (kind === "paper") return `A paper to read against ${building}.`;
  if (kind === "idea") return `An idea to fold into ${building}.`;
  if (kind === "event") return `An event for people building ${building}.`;
  return `Worth keeping next to ${building}.`;
}
