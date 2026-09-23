/**
 * The help articles at `/help/:slug`, read from `src/content/help/*.md` at build time.
 *
 * Why Markdown files in the repo rather than a CMS or Plain's own Help Center: the articles are
 * customer-facing product documentation, so they change with the product and belong in the same
 * commit as the feature they describe. Plain's AI agent (Ari) indexes them through the sitemap
 * (`src/app/sitemap.ts`) and answers support chat from them, which is the whole reason they are
 * public pages and not a PDF or a login-walled doc: Ari can only read HTML it can fetch.
 *
 * Front matter is three keys — `title`, `description`, `order` — parsed here without a dependency.
 * The slug is the file name. `order` sorts the index; ties fall back to the title.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type HelpArticle = {
  slug: string;
  title: string;
  description: string;
  order: number;
  /** The Markdown body, front matter removed. */
  body: string;
};

const CONTENT_DIR = path.join(process.cwd(), "src", "content", "help");

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Split `---\nkey: value\n---\nbody` into its keys and the body. Missing front matter yields no keys. */
function parseFrontMatter(raw: string): { keys: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { keys: {}, body: raw };
  const keys: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    keys[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { keys, body: m[2] };
}

/** Every article, sorted for the index. Empty when the content folder does not exist yet. */
export function listHelpArticles(): HelpArticle[] {
  let files: string[];
  try {
    files = readdirSync(CONTENT_DIR);
  } catch {
    return [];
  }
  const articles: HelpArticle[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    const { keys, body } = parseFrontMatter(readFileSync(path.join(CONTENT_DIR, file), "utf8"));
    const title = keys.title || slug.replace(/-/g, " ");
    const order = Number.parseInt(keys.order ?? "", 10);
    articles.push({
      slug,
      title,
      description: keys.description || "",
      order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
      body: body.trim(),
    });
  }
  return articles.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** One article by slug, or null. */
export function getHelpArticle(slug: string): HelpArticle | null {
  if (!SLUG_RE.test(slug)) return null;
  return listHelpArticles().find((a) => a.slug === slug) ?? null;
}
