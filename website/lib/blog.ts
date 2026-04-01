import fs from "fs";
import path from "path";
import matter from "gray-matter";
import readingTime from "reading-time";

const CONTENT_DIR = path.join(process.cwd(), "..", "content", "blog");

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  draft: boolean;
  readingTime: string;
  content: string;
}

export interface BlogPostMeta {
  slug: string;
  title: string;
  date: string;
  author: string;
  tags: string[];
  excerpt: string;
  draft: boolean;
  readingTime: string;
}

function parseMdxFile(filePath: string): BlogPost | null {
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
    draft: data.draft || false,
    readingTime: stats.text,
    content,
  };
}

export function getAllPosts(): BlogPostMeta[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith(".mdx"));

  const posts = files
    .map(file => parseMdxFile(path.join(CONTENT_DIR, file)))
    .filter((post): post is BlogPost => post !== null)
    .map(({ content: _, ...meta }) => meta)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return posts;
}

export function getPostBySlug(slug: string): BlogPost | null {
  if (!fs.existsSync(CONTENT_DIR)) return null;

  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith(".mdx"));

  for (const file of files) {
    const post = parseMdxFile(path.join(CONTENT_DIR, file));
    if (post && post.slug === slug) {
      return post;
    }
  }

  return null;
}

export function getAllSlugs(): string[] {
  return getAllPosts().map(post => post.slug);
}

export function getAllTags(): string[] {
  const tags = new Set<string>();
  for (const post of getAllPosts()) {
    for (const tag of post.tags) {
      tags.add(tag);
    }
  }
  return Array.from(tags).sort();
}

export function getRelatedPosts(slug: string, limit = 3): BlogPostMeta[] {
  const current = getPostBySlug(slug);
  if (!current) return [];

  const all = getAllPosts().filter(p => p.slug !== slug);

  const scored = all.map(post => {
    const sharedTags = post.tags.filter(t => current.tags.includes(t)).length;
    return { post, score: sharedTags };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => s.post);
}
