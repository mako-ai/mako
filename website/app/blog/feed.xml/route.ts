import { getAllPosts } from "@/lib/blog";

const SITE_URL = "https://mako.ai";

export function GET() {
  const posts = getAllPosts();

  const items = posts
    .map(
      post => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${SITE_URL}/blog/${post.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${post.slug}</guid>
      <description><![CDATA[${post.excerpt}]]></description>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <author>${post.author}</author>
      ${post.tags.map(tag => `<category>${tag}</category>`).join("\n      ")}
    </item>`,
    )
    .join("");

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Mako Blog</title>
    <link>${SITE_URL}/blog</link>
    <description>Product updates, engineering deep dives, and database tips from the Mako team.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />${items}
  </channel>
</rss>`;

  return new Response(feed.trim(), {
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
