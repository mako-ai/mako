import { Metadata } from "next";
import Link from "next/link";
import { getAllGuides } from "@/lib/guides";

export const metadata: Metadata = {
  title: "Database Guides — Mako",
  description:
    "Practical guides for PostgreSQL, MySQL, ClickHouse, MongoDB, and more. GUI clients, import/export, SQL tips, and migration paths.",
  openGraph: {
    title: "Database Guides — Mako",
    description:
      "Practical guides for PostgreSQL, MySQL, ClickHouse, MongoDB, and more.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Database Guides — Mako",
    description:
      "Practical guides for PostgreSQL, MySQL, ClickHouse, MongoDB, and more.",
  },
};

export default function GuidesIndex() {
  const guides = getAllGuides();

  return (
    <div className="min-h-screen bg-white dark:bg-black text-zinc-900 dark:text-white">
      {/* Gradient Background */}
      <div className="fixed inset-0 pointer-events-none dark:opacity-100 opacity-30">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-zinc-400/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-500/20 rounded-full blur-[120px]" />
      </div>

      {/* Navigation */}
      <GuidesNav />

      {/* Header */}
      <div className="relative z-10 pt-32 pb-16 px-6">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Database Guides
          </h1>
          <p className="text-lg text-zinc-500 dark:text-zinc-400 max-w-2xl">
            Practical, no-fluff guides for working with databases. GUI clients,
            import/export, SQL tips, migration paths, and more.
          </p>
        </div>
      </div>

      {/* Guides Grid */}
      <div className="relative z-10 px-6 pb-24">
        <div className="max-w-4xl mx-auto">
          {guides.length === 0 ? (
            <p className="text-zinc-500 dark:text-zinc-400">
              Guides coming soon.
            </p>
          ) : (
            <div className="grid gap-6">
              {guides.map(guide => (
                <Link
                  key={guide.slug}
                  href={`/guides/${guide.slug}`}
                  className="group block p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-semibold group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {guide.title}
                      </h2>
                      <p className="text-zinc-500 dark:text-zinc-400 mt-2 line-clamp-2">
                        {guide.excerpt}
                      </p>
                      <div className="flex items-center gap-3 mt-3 text-sm text-zinc-400 dark:text-zinc-500">
                        <span>{guide.readingTime}</span>
                        {guide.database && (
                          <>
                            <span>·</span>
                            <span className="px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs font-medium">
                              {guide.database}
                            </span>
                          </>
                        )}
                        {guide.tags.slice(0, 3).map(tag => (
                          <span
                            key={tag}
                            className="px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="text-zinc-300 dark:text-zinc-600 group-hover:text-zinc-400 dark:group-hover:text-zinc-500 transition-colors mt-1">
                      →
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GuidesNav() {
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
              href="https://github.com/mako-ai/mako"
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
