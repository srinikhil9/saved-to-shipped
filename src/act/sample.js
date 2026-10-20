import { classify } from "../classify.js";
import { combinedText, ingest } from "../ingest.js";

/**
 * The same save object the pipeline hands to act(), built from a fixture.
 * Used by `npm run act:demo` and the act tests. No network.
 */
export async function sampleSave(url) {
  const post = await ingest(url, {
    offline: true,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const sorted = await classify({ text: combinedText(post), links: post.links || [] }, { env: {} });
  const author = post.author && post.handle ? `${post.author} (@${post.handle})` : post.author || (post.handle ? `@${post.handle}` : null);
  return {
    id: post.id,
    url: post.url,
    author,
    text: post.text || "",
    summary: sorted.summary,
    kind: sorted.kind,
    details: sorted.details,
  };
}
