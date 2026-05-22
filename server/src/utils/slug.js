'use strict';

/**
 * Convert an arbitrary name into a url-safe slug.
 *
 *   "Productivity & Tools" -> "productivity-tools"
 *   "  AI / ML  "          -> "ai-ml"
 *   "中文 名称 v2"          -> "v2"   (non-ASCII filtered)
 *
 * Rules:
 * - lowercase
 * - replace runs of non [a-z0-9] with a single dash
 * - trim leading/trailing dashes
 *
 * If the result is empty (e.g. the name had no ASCII letters/digits at all),
 * return null so the caller can decide to throw or fall back.
 */
function slugify(name) {
  if (typeof name !== 'string') return null;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : null;
}

module.exports = { slugify };
