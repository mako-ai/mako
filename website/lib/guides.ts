import fs from "fs";
import path from "path";
import matter from "gray-matter";
import readingTime from "reading-time";

const CONTENT_DIR = path.join(process.cwd(), "..", "content", "guides");

export interface Guide {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  metaDescription: string;
  draft: boolean;
  readingTime: string;
  content: string;
  database?: string;
  category?: string;
}

export interface GuideMeta {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  metaDescription: string;
  draft: boolean;
  readingTime: string;
  database?: string;
  category?: string;
}

function parseMdxFile(filePath: string): Guide | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  if (data.draft && process.env.NODE_ENV === "production") {
    return null;
  }

  const slug = data.slug || path.basename(filePath, ".mdx");
  const stats = readingTime(content);

  return {
    slug,
    title: data.title || "Untitled",
    date: data.date
      ? new Date(data.date).toISOString()
      : new Date().toISOString(),
    author: data.author || "Mako Team",
    tags: data.tags || [],
    excerpt: data.excerpt || "",
    metaDescription: data.metaDescription || data.excerpt || "",
    draft: data.draft || false,
    readingTime: stats.text,
    content,
    database: data.database,
    category: data.category,
  };
}

export function getAllGuides(): GuideMeta[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));

  const guides = files
    .map((file) => parseMdxFile(path.join(CONTENT_DIR, file)))
    .filter((guide): guide is Guide => guide !== null)
    .map(({ content: _, ...meta }) => meta)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return guides;
}

export function getGuideBySlug(slug: string): Guide | null {
  if (!fs.existsSync(CONTENT_DIR)) return null;

  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));

  for (const file of files) {
    const guide = parseMdxFile(path.join(CONTENT_DIR, file));
    if (guide && guide.slug === slug) {
      return guide;
    }
  }

  return null;
}

export function getAllGuideSlugs(): string[] {
  return getAllGuides().map((guide) => guide.slug);
}

export function getGuidesByDatabase(database: string): GuideMeta[] {
  return getAllGuides().filter(
    (g) => g.database?.toLowerCase() === database.toLowerCase()
  );
}

export function getGuidesByCategory(category: string): GuideMeta[] {
  return getAllGuides().filter(
    (g) => g.category?.toLowerCase() === category.toLowerCase()
  );
}

export function getRelatedGuides(slug: string, limit = 3): GuideMeta[] {
  const current = getGuideBySlug(slug);
  if (!current) return [];

  const all = getAllGuides().filter((g) => g.slug !== slug);

  const scored = all.map((guide) => {
    let score = 0;
    score += guide.tags.filter((t) => current.tags.includes(t)).length * 2;
    if (guide.database === current.database) score += 3;
    if (guide.category === current.category) score += 1;
    return { guide, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.guide);
}
