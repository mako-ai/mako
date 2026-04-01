"use client";

import Link from "next/link";
import { useState } from "react";

// V7: Video Hero - Large hero section with video/animation showing AI in action
export default function V7VideoHero() {
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <div className="min-h-screen bg-[#09090b] text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-[#09090b]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <MakoIcon className="w-7 h-7" />
            <span className="font-bold text-xl">Mako</span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm text-zinc-400">
            <Link href="#demo" className="hover:text-white transition-colors">
              Demo
            </Link>
            <Link
              href="#features"
              className="hover:text-white transition-colors"
            >
              Features
            </Link>
            <Link
              href="https://github.com/mako-ai/mono"
              className="hover:text-white transition-colors"
            >
              GitHub
            </Link>
            <Link
              href="https://docs.mako.ai"
              className="hover:text-white transition-colors"
            >
              Docs
            </Link>
          </div>
          <a
            href="https://app.mako.ai"
            className="px-5 py-2 text-sm font-medium bg-white text-black rounded-full hover:bg-zinc-200 transition-colors"
          >
            Open App
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-8 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full border border-white/10 bg-white/5 mb-8">
            <span className="flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-zinc-400">Free &amp; Open Source</span>
            </span>
            <span className="text-zinc-600">|</span>
            <a
              href="https://github.com/mako-ai/mono"
              className="text-sm text-zinc-400 hover:text-white transition-colors flex items-center gap-1"
            >
              <GitHubIcon className="w-4 h-4" />
              Star on GitHub
            </a>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-[1.1]">
            Watch AI write your
            <br />
            <span className="bg-gradient-to-r from-amber-200 via-yellow-300 to-orange-400 bg-clip-text text-transparent">
              database queries
            </span>
          </h1>

          <p className="text-xl text-zinc-400 max-w-2xl mx-auto mb-10">
            The AI-powered SQL client that understands your schema, writes
            optimized queries, and helps your team collaborate—all from the
            browser.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-black font-bold rounded-full hover:opacity-90 transition-opacity"
            >
              Try It Free
            </a>
            <a
              href="#demo"
              className="w-full sm:w-auto px-8 py-4 border border-zinc-700 text-white font-semibold rounded-full hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2"
            >
              <PlayIcon className="w-5 h-5" />
              Watch Demo
            </a>
          </div>
        </div>
      </section>

      {/* Video Section */}
      <section id="demo" className="pb-20 px-6">
        <div className="max-w-5xl mx-auto">
          <div
            className="relative aspect-video rounded-2xl overflow-hidden border border-white/10 bg-zinc-900 cursor-pointer group"
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {!isPlaying ? (
              <>
                {/* Placeholder with animated demo */}
                <AnimatedDemo />

                {/* Play button overlay */}
                <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                  <div className="w-20 h-20 rounded-full bg-white/90 flex items-center justify-center group-hover:scale-110 transition-transform shadow-2xl">
                    <PlayIcon className="w-8 h-8 text-black ml-1" />
                  </div>
                </div>
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <AnimatedDemo fullscreen />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Built for the AI era</h2>
            <p className="text-xl text-zinc-400">
              Everything you need to query databases, now powered by AI.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              icon="✨"
              title="AI Query Generation"
              description="Describe what you want in plain English. Our AI understands your schema and writes optimized SQL."
            />
            <FeatureCard
              icon="👥"
              title="Team Collaboration"
              description="Share connections, collaborate on queries, and maintain version-controlled SQL snippets."
            />
            <FeatureCard
              icon="⚡"
              title="Instant APIs"
              description="Turn any query into a REST endpoint with one click. Perfect for prototyping."
            />
            <FeatureCard
              icon="☁️"
              title="Zero Installation"
              description="Works entirely in your browser. No downloads, no config, just connect and query."
            />
            <FeatureCard
              icon="💚"
              title="Open Source"
              description="MIT licensed. Self-host it, fork it, customize it. Your data stays yours."
            />
            <FeatureCard
              icon="🗄️"
              title="Multi-Database"
              description="PostgreSQL, MySQL, MongoDB, BigQuery, and more. One tool for all databases."
            />
          </div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="py-24 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-12">Loved by developers</h2>

          <div className="grid md:grid-cols-3 gap-6">
            <TestimonialCard
              quote="Finally, a SQL client that doesn't feel like it's from 2005. The AI actually understands what I want."
              author="Sarah K."
              role="Backend Engineer"
            />
            <TestimonialCard
              quote="We replaced DataGrip with Mako across our entire team. The collaboration features are a game changer."
              author="Mike T."
              role="Engineering Lead"
            />
            <TestimonialCard
              quote="The one-click API feature saved us weeks of work building internal dashboards."
              author="Alex R."
              role="Full Stack Developer"
            />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="p-12 rounded-3xl bg-gradient-to-r from-amber-500/20 via-orange-500/10 to-red-500/20 border border-amber-500/20 text-center">
            <h2 className="text-4xl font-bold mb-4">
              Ready to try AI-powered queries?
            </h2>
            <p className="text-xl text-zinc-400 mb-8">
              Free forever. No credit card required.
            </p>
            <a
              href="https://app.mako.ai"
              className="inline-flex items-center gap-2 px-10 py-4 bg-gradient-to-r from-amber-400 to-orange-500 text-black font-bold rounded-full hover:opacity-90 transition-opacity"
            >
              Get Started Free
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 8l4 4m0 0l-4 4m4-4H3"
                />
              </svg>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-400 text-sm">
              © 2025 Mako. MIT License.
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-400">
            <a
              href="https://github.com/mako-ai/mono"
              className="hover:text-white transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://docs.mako.ai"
              className="hover:text-white transition-colors"
            >
              Docs
            </a>
            <a href="#" className="hover:text-white transition-colors">
              Discord
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function AnimatedDemo({ fullscreen = false }: { fullscreen?: boolean }) {
  return (
    <div
      className={`${fullscreen ? "p-8" : "p-6"} font-mono text-sm h-full flex flex-col`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <div className="w-3 h-3 rounded-full bg-green-500" />
        </div>
        <span className="text-zinc-500 text-xs ml-2">mako — production-db</span>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-4">
        {/* AI Input */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <span className="text-amber-400">✨</span>
          <span className="text-zinc-300">
            Show me monthly revenue for 2024 grouped by product category
          </span>
          <span className="animate-pulse text-amber-400">|</span>
        </div>

        {/* Thinking */}
        <div className="text-zinc-500 text-xs animate-pulse">
          Analyzing schema... found 23 tables, generating optimized query...
        </div>

        {/* Generated SQL */}
        <div className="p-4 rounded-lg bg-zinc-800/50 space-y-1">
          <div>
            <span className="text-blue-400">SELECT</span>
          </div>
          <div className="pl-4">
            <span className="text-white">DATE_TRUNC</span>
            <span className="text-zinc-400">(</span>
            <span className="text-amber-400">&apos;month&apos;</span>
            <span className="text-zinc-400">, </span>
            <span className="text-white">o.created_at</span>
            <span className="text-zinc-400">) </span>
            <span className="text-blue-400">AS</span>
            <span className="text-white"> month,</span>
          </div>
          <div className="pl-4">
            <span className="text-white">p.category,</span>
          </div>
          <div className="pl-4">
            <span className="text-yellow-400">SUM</span>
            <span className="text-zinc-400">(</span>
            <span className="text-white">o.total</span>
            <span className="text-zinc-400">) </span>
            <span className="text-blue-400">AS</span>
            <span className="text-white"> revenue</span>
          </div>
          <div>
            <span className="text-blue-400">FROM</span>{" "}
            <span className="text-emerald-400">orders</span>{" "}
            <span className="text-white">o</span>
          </div>
          <div>
            <span className="text-blue-400">JOIN</span>{" "}
            <span className="text-emerald-400">products</span>{" "}
            <span className="text-white">p</span>{" "}
            <span className="text-blue-400">ON</span>{" "}
            <span className="text-white">o.product_id = p.id</span>
          </div>
          <div>
            <span className="text-blue-400">WHERE</span>{" "}
            <span className="text-white">o.created_at</span>{" "}
            <span className="text-pink-400">&gt;=</span>{" "}
            <span className="text-amber-400">&apos;2024-01-01&apos;</span>
          </div>
          <div>
            <span className="text-blue-400">GROUP BY</span>{" "}
            <span className="text-white">1, 2</span>{" "}
            <span className="text-blue-400">ORDER BY</span>{" "}
            <span className="text-white">1, 3</span>{" "}
            <span className="text-blue-400">DESC</span>
            <span className="text-white">;</span>
          </div>
        </div>

        {/* Success */}
        <div className="flex items-center gap-2 text-emerald-400 text-xs">
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
              d="M5 13l4 4L19 7"
            />
          </svg>
          Query executed in 34ms • 48 rows returned
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors">
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-zinc-400 text-sm leading-relaxed">{description}</p>
    </div>
  );
}

function TestimonialCard({
  quote,
  author,
  role,
}: {
  quote: string;
  author: string;
  role: string;
}) {
  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-white/5 text-left">
      <p className="text-zinc-300 text-sm mb-4">&quot;{quote}&quot;</p>
      <div>
        <div className="font-medium">{author}</div>
        <div className="text-zinc-500 text-sm">{role}</div>
      </div>
    </div>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
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

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
