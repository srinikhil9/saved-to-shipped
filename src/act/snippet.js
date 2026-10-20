/**
 * Feed-card partial. The zip URL is one we generated (/artifacts/<id>/<name>.zip).
 * Anything else is dropped so a saved action blob cannot inject a link.
 */

const ZIP_HREF = /^\/artifacts\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.zip$/;
const SAFE_FILE = /^[A-Za-z0-9._/-]+$/;

export function renderZipLink(action) {
  const href = artifactHref(action?.zipUrl);
  if (!href) return "";
  const specHref = `${href.slice(0, href.lastIndexOf("/"))}/SPEC.md`;
  return `<p class="artifact"><a href="${escapeHtml(href)}">Download starter</a> · <a href="${escapeHtml(specHref)}">Read SPEC.md</a></p>`;
}

export function renderFileList(files) {
  const safe = (files || []).filter((file) => typeof file === "string" && SAFE_FILE.test(file) && !file.includes(".."));
  if (!safe.length) return "";
  return `<ul class="files">${safe.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`;
}

function artifactHref(value) {
  if (typeof value !== "string" || !ZIP_HREF.test(value)) return null;
  return value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
