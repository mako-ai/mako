import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllSlugs, getPostBySlug, getRelatedPosts } from "@/lib/blog";
import { MdxContent } from "@/lib/mdx";

interface PageProps {
  params: { slug: string };
}

export function generateStaticParams() {
  return getAllSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: PageProps): Metadata {
  const post = getPostBySlug(params.slug);
  if (!post) return { title: "Post Not Found — Mako" };

  return {
    title: `${post.title} — Mako Blog`,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: "article",
      publishedTime: post.date,
      authors: [post.author],
      tags: post.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.excerpt,
    },
  };
}

export default function BlogPost({ params }: PageProps) {
  const post = getPostBySlug(params.slug);
  if (!post) notFound();

  const related = getRelatedPosts(params.slug, 3);

  return (
    <div className="min-h-screen bg-white dark:bg-black text-zinc-900 dark:text-white">
      {/* Gradient Background */}
      <div className="fixed inset-0 pointer-events-none dark:opacity-100 opacity-30">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-zinc-400/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-500/20 rounded-full blur-[120px]" />
      </div>

      {/* Navigation */}
      <PostNav />

      {/* Article */}
      <article className="relative z-10 pt-32 pb-16 px-6">
        <div className="max-w-3xl mx-auto">
          {/* Back link */}
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors mb-8"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16l-4-4m0 0l4-4m-4 4h18"
              />
            </svg>
            Back to blog
          </Link>

          {/* Header */}
          <header className="mb-12">
            <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
              <time
                dateTime={post.date}
                className="text-zinc-400 dark:text-zinc-500"
              >
                {new Date(post.date).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </time>
              <span className="text-zinc-300 dark:text-zinc-700">&middot;</span>
              <span className="text-zinc-400 dark:text-zinc-500">
                {post.readingTime}
              </span>
              <span className="text-zinc-300 dark:text-zinc-700">&middot;</span>
              <span className="text-zinc-400 dark:text-zinc-500">
                {post.author}
              </span>
            </div>

            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6 leading-tight">
              {post.title}
            </h1>

            <div className="flex flex-wrap gap-2">
              {post.tags.map(tag => (
                <span
                  key={tag}
                  className="px-2.5 py-1 text-xs rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                >
                  {tag}
                </span>
              ))}
            </div>
          </header>

          {/* Content */}
          <div className="mdx-content">
            <MdxContent source={post.content} />
          </div>
        </div>
      </article>

      {/* Related Posts */}
      {related.length > 0 && (
        <section className="relative z-10 pb-24 px-6 border-t border-zinc-200 dark:border-white/10">
          <div className="max-w-4xl mx-auto pt-16">
            <h2 className="text-2xl font-bold mb-8">Related posts</h2>
            <div className="grid md:grid-cols-3 gap-6">
              {related.map(relPost => (
                <Link
                  key={relPost.slug}
                  href={`/blog/${relPost.slug}`}
                  className="group"
                >
                  <article className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-lg transition-all h-full">
                    <time
                      dateTime={relPost.date}
                      className="text-xs text-zinc-400 dark:text-zinc-500"
                    >
                      {new Date(relPost.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                    <h3 className="text-base font-semibold mt-2 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors">
                      {relPost.title}
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2 line-clamp-2">
                      {relPost.excerpt}
                    </p>
                  </article>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="relative z-10 py-12 px-6 border-t border-zinc-200 dark:border-white/10">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-400 text-sm">
              &copy; 2025 Mako. Open source under MIT.
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-400">
            <a
              href="https://github.com/mako-ai/mono"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://docs.mako.ai"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Docs
            </a>
            <Link
              href="/blog/feed.xml"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              RSS
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function PostNav() {
  return (
    <nav className="fixed top-0 w-full z-50 bg-white/70 dark:bg-black/70 backdrop-blur-xl border-b border-zinc-200/50 dark:border-white/10">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-10">
          <Link href="/" className="flex items-center gap-2">
            <MakoIcon className="w-7 h-7" />
            <span className="font-bold text-xl">mako</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm text-zinc-500 dark:text-zinc-400">
            <Link
              href="/#features"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Features
            </Link>
            <Link
              href="/blog"
              className="text-zinc-900 dark:text-white font-medium"
            >
              Blog
            </Link>
            <Link
              href="https://docs.mako.ai"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Documentation
            </Link>
            <Link
              href="https://github.com/mako-ai/mono"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              GitHub
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="https://app.mako.ai"
            className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
          >
            Sign in
          </a>
          <a
            href="https://app.mako.ai"
            className="px-4 py-2 text-sm font-medium bg-zinc-900 dark:bg-white text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
          >
            Get Started
          </a>
        </div>
      </div>
    </nav>
  );
}

function MakoIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 102 90"
      fill="currentColor"
      className={className}
    >
      <path d="m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z" />
    </svg>
  );
}
