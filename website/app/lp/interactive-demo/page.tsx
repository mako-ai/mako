"use client";

import Link from "next/link";
import { useState } from "react";

// V9: Interactive Demo - Hands-on demo widget in the hero
export default function V9InteractiveDemo() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-slate-900/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <MakoIcon className="w-7 h-7" />
            <span className="font-bold text-xl">Mako</span>
          </Link>
          <div className="hidden md:flex items-center gap-6 text-sm text-slate-400">
            <Link
              href="#features"
              className="hover:text-white transition-colors"
            >
              Features
            </Link>
            <Link
              href="https://github.com/mako-ai/mako"
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
            className="px-4 py-2 text-sm font-medium bg-gradient-to-r from-rose-500 to-orange-500 text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            Open App
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-28 pb-12 px-6">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm mb-6">
            <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
            Try it now — no signup required
          </div>

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            Experience AI-powered
            <span className="block bg-gradient-to-r from-rose-400 to-orange-400 bg-clip-text text-transparent">
              SQL queries
            </span>
          </h1>

          <p className="text-xl text-slate-400 max-w-2xl mx-auto">
            Type a question below and watch AI generate the perfect SQL query.
            Free, open source, and works with any database.
          </p>
        </div>

        {/* Interactive Demo */}
        <InteractiveDemo />
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-16">
            More than just AI queries
          </h2>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <FeatureCard
              icon="✨"
              title="AI Query Generation"
              description="Natural language to optimized SQL in seconds."
            />
            <FeatureCard
              icon="👥"
              title="Team Collaboration"
              description="Shared connections and version-controlled snippets."
            />
            <FeatureCard
              icon="⚡"
              title="Instant APIs"
              description="One-click REST endpoints from any query."
            />
            <FeatureCard
              icon="☁️"
              title="Zero Installation"
              description="Works entirely in your browser."
            />
          </div>
        </div>
      </section>

      {/* Databases */}
      <section className="py-24 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-4">Connect to any database</h2>
          <p className="text-slate-400 mb-12">
            PostgreSQL, MySQL, MongoDB, BigQuery, and more.
          </p>

          <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
            {[
              "postgresql",
              "mysql",
              "mongodb",
              "bigquery",
              "snowflake",
              "clickhouse",
            ].map(db => (
              <div
                key={db}
                className="p-4 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center"
              >
                <span className="text-sm text-slate-400 capitalize">{db}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="p-12 rounded-3xl bg-gradient-to-r from-rose-500/20 to-orange-500/20 border border-rose-500/20 text-center">
            <h2 className="text-4xl font-bold mb-4">
              Ready for the full experience?
            </h2>
            <p className="text-xl text-slate-400 mb-8">
              Connect your database and start querying with AI. Free forever.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href="https://app.mako.ai"
                className="w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-rose-500 to-orange-500 text-white font-bold rounded-lg hover:opacity-90 transition-opacity"
              >
                Launch Mako
              </a>
              <a
                href="https://github.com/mako-ai/mako"
                className="w-full sm:w-auto px-8 py-4 border border-white/20 text-white font-semibold rounded-lg hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
              >
                <GitHubIcon className="w-5 h-5" />
                View Source
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-slate-400 text-sm">
              © 2025 Mako. MIT License.
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-400">
            <a
              href="https://github.com/mako-ai/mako"
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

function InteractiveDemo() {
  const [query, setQuery] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSQL, setGeneratedSQL] = useState("");

  const examples = [
    "Show me all users who signed up last week",
    "Find the top 10 products by revenue",
    "Calculate monthly active users for 2024",
    "List orders that are pending shipment",
  ];

  const handleGenerate = (input: string) => {
    setQuery(input);
    setIsGenerating(true);
    setGeneratedSQL("");

    // Simulate AI generation
    setTimeout(() => {
      const sqlExamples: Record<string, string> = {
        "Show me all users who signed up last week": `SELECT *
FROM users
WHERE created_at >= NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;`,
        "Find the top 10 products by revenue": `SELECT p.name, SUM(oi.quantity * oi.price) AS revenue
FROM products p
JOIN order_items oi ON p.id = oi.product_id
JOIN orders o ON oi.order_id = o.id
WHERE o.status = 'completed'
GROUP BY p.id, p.name
ORDER BY revenue DESC
LIMIT 10;`,
        "Calculate monthly active users for 2024": `SELECT DATE_TRUNC('month', last_active) AS month,
       COUNT(DISTINCT id) AS active_users
FROM users
WHERE last_active >= '2024-01-01'
GROUP BY 1
ORDER BY 1;`,
        "List orders that are pending shipment": `SELECT o.id, o.created_at, u.email, o.total
FROM orders o
JOIN users u ON o.user_id = u.id
WHERE o.status = 'pending_shipment'
ORDER BY o.created_at ASC;`,
      };
      setGeneratedSQL(
        sqlExamples[input] ||
          `SELECT *
FROM your_table
WHERE condition = 'value';`,
      );
      setIsGenerating(false);
    }, 1500);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="rounded-2xl border border-white/10 bg-slate-800/50 backdrop-blur overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-slate-800 border-b border-white/5">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <span className="text-xs text-slate-500 ml-2">
            mako — interactive demo
          </span>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Input */}
          <div className="mb-6">
            <label className="text-sm text-slate-400 mb-2 block">
              Ask anything about your data
            </label>
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e =>
                  e.key === "Enter" && query && handleGenerate(query)
                }
                placeholder="e.g., Show me all users who signed up last week"
                className="w-full px-4 py-3 pr-24 rounded-xl bg-slate-900 border border-white/10 text-white placeholder:text-slate-500 focus:outline-none focus:border-rose-500/50 focus:ring-2 focus:ring-rose-500/20"
              />
              <button
                onClick={() => query && handleGenerate(query)}
                disabled={!query || isGenerating}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 rounded-lg bg-gradient-to-r from-rose-500 to-orange-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isGenerating ? "..." : "Generate"}
              </button>
            </div>
          </div>

          {/* Example prompts */}
          <div className="mb-6">
            <div className="text-xs text-slate-500 mb-2">Try an example:</div>
            <div className="flex flex-wrap gap-2">
              {examples.map((example, i) => (
                <button
                  key={i}
                  onClick={() => handleGenerate(example)}
                  className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          {/* Generated SQL */}
          <div className="min-h-[200px]">
            {isGenerating ? (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-slate-900/50">
                <div className="w-5 h-5 border-2 border-rose-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-slate-400">
                  Analyzing schema and generating query...
                </span>
              </div>
            ) : generatedSQL ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-slate-400">Generated SQL</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(generatedSQL)}
                    className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
                  >
                    Copy to clipboard
                  </button>
                </div>
                <div className="p-4 rounded-xl bg-slate-900 font-mono text-sm overflow-x-auto">
                  <pre className="text-emerald-400 whitespace-pre-wrap">
                    {generatedSQL}
                  </pre>
                </div>
                <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                  <svg
                    className="w-4 h-4 text-emerald-400"
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
                  Ready to execute • Optimized for PostgreSQL
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-slate-500 text-sm">
                Type a question or click an example to see AI-generated SQL
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-800/50 border-t border-white/5 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            This is a demo. Connect your database in the full app.
          </span>
          <a
            href="https://app.mako.ai"
            className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
          >
            Open full app →
          </a>
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
      <p className="text-slate-400 text-sm">{description}</p>
    </div>
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
