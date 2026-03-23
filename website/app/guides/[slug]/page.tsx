import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllGuideSlugs,
  getGuideBySlug,
  getRelatedGuides,
} from "@/lib/guides";
import { MdxContent } from "@/lib/mdx";

interface PageProps {
  params: { slug: string };
}

export function generateStaticParams() {
  return getAllGuideSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: PageProps): Metadata {
  const guide = getGuideBySlug(params.slug);
  if (!guide) return { title: "Guide Not Found — Mako" };

  return {
    title: `${guide.title} — Mako`,
    description: guide.metaDescription || guide.excerpt,
    openGraph: {
      title: guide.title,
      description: guide.metaDescription || guide.excerpt,
      type: "article",
      publishedTime: guide.date,
      tags: guide.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: guide.title,
      description: guide.metaDescription || guide.excerpt,
    },
  };
}

export default function GuidePage({ params }: PageProps) {
  const guide = getGuideBySlug(params.slug);
  if (!guide) notFound();

  const related = getRelatedGuides(params.slug, 3);

  return (
    <div className="min-h-screen bg-white dark:bg-black text-zinc-900 dark:text-white">
      {/* Gradient Background */}
      <div className="fixed inset-0 pointer-events-none dark:opacity-100 opacity-30">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-zinc-400/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-500/20 rounded-full blur-[120px]" />
      </div>

      {/* Navigation */}
      <GuideNav />

      {/* Article */}
      <article className="relative z-10 pt-32 pb-16 px-6">
        <div className="max-w-3xl mx-auto">
          {/* Back link */}
          <Link
            href="/guides"
            className="inline-flex items-center gap-1.5 text-sm text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors mb-8"
          >
            ← All Guides
          </Link>

          {/* Title */}
          <h1 className="text-4xl md:text-5xl font-bold mb-4">{guide.title}</h1>

          {/* Meta */}
          <div className="flex items-center gap-4 text-sm text-zinc-400 dark:text-zinc-500 mb-10">
            <span>{guide.readingTime}</span>
            {guide.database && (
              <>
                <span>·</span>
                <span className="px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs font-medium">
                  {guide.database}
                </span>
              </>
            )}
            <span>·</span>
            <time>
              {new Date(guide.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </time>
          </div>

          {/* Content */}
          <div className="prose prose-zinc dark:prose-invert max-w-none">
            <MdxContent source={guide.content} />
          </div>
        </div>
      </article>

      {/* CTA */}
      <div className="relative z-10 px-6 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="p-8 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 text-center">
            <h2 className="text-2xl font-bold mb-2">
              Skip the terminal. Use Mako.
            </h2>
            <p className="text-zinc-500 dark:text-zinc-400 mb-6 max-w-lg mx-auto">
              Connect your database, write queries with AI assistance, and
              import/export data in clicks. Free to start.
            </p>
            <a
              href="https://app.mako.ai"
              className="inline-flex px-6 py-3 text-sm font-medium bg-zinc-900 dark:bg-white text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
            >
              Try Mako Free →
            </a>
          </div>
        </div>
      </div>

      {/* Related Guides */}
      {related.length > 0 && (
        <div className="relative z-10 px-6 pb-24">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-xl font-bold mb-6">Related Guides</h2>
            <div className="grid gap-4">
              {related.map(r => (
                <Link
                  key={r.slug}
                  href={`/guides/${r.slug}`}
                  className="group block p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
                >
                  <h3 className="font-semibold group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    {r.title}
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-1">
                    {r.excerpt}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GuideNav() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white/80 dark:bg-black/80 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
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
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Blog
            </Link>
            <Link
              href="/guides"
              className="text-zinc-900 dark:text-white font-medium"
            >
              Guides
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
