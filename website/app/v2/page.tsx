"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

// V2: Gradient Hero - Vercel/Raycast inspired with bold gradients
export default function V2GradientHero() {
  return (
    <div className="min-h-screen bg-black text-white overflow-hidden">
      {/* Gradient Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-purple-500/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] bg-blue-500/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-1/2 w-[800px] h-[400px] bg-cyan-500/20 rounded-full blur-[120px]" />
      </div>

      {/* Navigation */}
      <nav className="relative z-50 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-10">
            <Link href="/" className="flex items-center gap-2">
              <MakoIcon className="w-7 h-7" />
              <span className="font-bold text-xl">mako</span>
            </Link>
            <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
              <Link href="#features" className="hover:text-white transition-colors">Features</Link>
              <Link href="https://docs.mako.ai" className="hover:text-white transition-colors">Documentation</Link>
              <Link href="https://github.com/mako-ai/mono" className="hover:text-white transition-colors">GitHub</Link>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://app.mako.ai"
              className="px-4 py-2 text-sm font-medium rounded-full bg-white text-black hover:bg-zinc-200 transition-colors"
            >
              Launch App →
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 pt-24 pb-20 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/5 text-sm mb-8 backdrop-blur-sm">
            <span className="px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-500 to-blue-500 text-xs font-medium">NEW</span>
            <span className="text-zinc-300">AI Agents for Database Queries</span>
          </div>

          <h1 className="text-6xl md:text-8xl font-bold tracking-tight mb-8 leading-[0.9]">
            <span className="block">Query databases</span>
            <span className="block bg-gradient-to-r from-purple-400 via-pink-400 to-blue-400 bg-clip-text text-transparent">
              with superpowers
            </span>
          </h1>

          <p className="text-xl md:text-2xl text-zinc-400 max-w-3xl mx-auto mb-12 leading-relaxed">
            Mako is an open-source SQL client with AI that writes your queries,
            team collaboration, and instant API generation. No installation required.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <a
              href="https://app.mako.ai"
              className="group w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-purple-500 via-pink-500 to-blue-500 text-white font-semibold rounded-full hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
            >
              Start Building Free
              <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </a>
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-8 py-4 border border-white/20 text-white font-semibold rounded-full hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              Star on GitHub
            </a>
          </div>

          {/* Animated Query Demo */}
          <QueryDemo />
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="relative z-10 py-24 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Why developers love Mako
            </h2>
            <p className="text-xl text-zinc-400">
              Everything you need to work with databases, nothing you don&apos;t.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            <FeatureCard
              gradient="from-purple-500/20 to-blue-500/20"
              title="AI Query Generation"
              description="Just describe what you need. Our AI understands your schema and writes optimized SQL that actually works."
              icon="✨"
            />
            <FeatureCard
              gradient="from-pink-500/20 to-purple-500/20"
              title="Real-time Collaboration"
              description="Share connections, queries, and results with your team. Version control for your SQL snippets."
              icon="👥"
            />
            <FeatureCard
              gradient="from-blue-500/20 to-cyan-500/20"
              title="One-Click REST APIs"
              description="Turn any query into an API endpoint instantly. Perfect for dashboards and internal tools."
              icon="⚡"
            />
            <FeatureCard
              gradient="from-emerald-500/20 to-blue-500/20"
              title="Zero Installation"
              description="Runs entirely in your browser. No downloads, no setup, no updates to manage."
              icon="☁️"
            />
            <FeatureCard
              gradient="from-orange-500/20 to-pink-500/20"
              title="Multi-Database Support"
              description="PostgreSQL, MySQL, MongoDB, BigQuery, SQLite, and more. All in one place."
              icon="🗄️"
            />
            <FeatureCard
              gradient="from-cyan-500/20 to-emerald-500/20"
              title="100% Open Source"
              description="MIT licensed. Self-host it, fork it, customize it. Your data stays yours."
              icon="💚"
            />
          </div>
        </div>
      </section>

      {/* Comparison Section */}
      <section className="relative z-10 py-24 px-6 border-t border-white/10">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-4">
            The modern alternative
          </h2>
          <p className="text-xl text-zinc-400 text-center mb-16">
            Built for teams who want more than a legacy SQL client.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            <CompetitorCard name="vs DataGrip" issue="$199/year, no AI, no collaboration" />
            <CompetitorCard name="vs DBeaver" issue="Slow, cluttered UI, no web version" />
            <CompetitorCard name="vs Postico" issue="Mac only, no AI, no team features" />
            <CompetitorCard name="vs TablePlus" issue="Limited free tier, no AI assistance" />
          </div>

          <div className="mt-16 p-8 rounded-2xl border border-white/10 bg-gradient-to-r from-purple-500/10 via-transparent to-blue-500/10">
            <div className="flex flex-col md:flex-row items-center justify-between gap-6">
              <div>
                <h3 className="text-2xl font-bold mb-2">Mako is different</h3>
                <p className="text-zinc-400">Free, open source, AI-native, and built for collaboration.</p>
              </div>
              <a
                href="https://app.mako.ai"
                className="px-6 py-3 bg-white text-black font-semibold rounded-full hover:bg-zinc-200 transition-colors whitespace-nowrap"
              >
                Try it free →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 py-24 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-5xl md:text-6xl font-bold mb-6">
            Ready to query smarter?
          </h2>
          <p className="text-xl text-zinc-400 mb-10">
            Join developers who&apos;ve upgraded their database workflow.
          </p>
          <a
            href="https://app.mako.ai"
            className="inline-flex items-center gap-2 px-10 py-5 bg-gradient-to-r from-purple-500 via-pink-500 to-blue-500 text-white font-bold text-lg rounded-full hover:opacity-90 transition-opacity"
          >
            Get Started Free
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 py-12 px-6 border-t border-white/10">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-400 text-sm">© 2025 Mako. Open source under MIT.</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-400">
            <a href="https://github.com/mako-ai/mono" className="hover:text-white transition-colors">GitHub</a>
            <a href="https://docs.mako.ai" className="hover:text-white transition-colors">Docs</a>
            <a href="#" className="hover:text-white transition-colors">Discord</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function QueryDemo() {
  const [step, setStep] = useState(0);
  const steps = [
    { prompt: "Show me users who signed up last week", typing: true },
    { prompt: "Show me users who signed up last week", typing: false },
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setStep((s) => (s + 1) % 2);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="rounded-2xl border border-white/10 bg-zinc-900/80 backdrop-blur-xl overflow-hidden shadow-2xl">
        {/* Window header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-zinc-900">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <span className="text-xs text-zinc-500">mako — production</span>
          <div className="w-16" />
        </div>

        {/* Content */}
        <div className="p-6">
          {/* AI Input */}
          <div className="flex items-center gap-3 p-4 rounded-xl bg-zinc-800/50 border border-white/5 mb-6">
            <div className="w-8 h-8 rounded-full bg-gradient-to-r from-purple-500 to-blue-500 flex items-center justify-center text-sm">
              ✨
            </div>
            <span className="text-zinc-300 font-mono text-sm">
              {steps[step].prompt}
              {steps[step].typing && <span className="animate-pulse">|</span>}
            </span>
          </div>

          {/* Generated SQL */}
          <div className="font-mono text-sm text-left">
            <div className="text-zinc-500 mb-2">-- AI Generated SQL</div>
            <div className="text-blue-400">SELECT <span className="text-white">*</span></div>
            <div className="text-blue-400">FROM <span className="text-emerald-400">users</span></div>
            <div className="text-blue-400">WHERE <span className="text-white">created_at</span> <span className="text-pink-400">&gt;=</span> <span className="text-yellow-400">NOW</span><span className="text-white">() - </span><span className="text-orange-400">INTERVAL &apos;7 days&apos;</span></div>
            <div className="text-blue-400">ORDER BY <span className="text-white">created_at</span> <span className="text-blue-400">DESC</span><span className="text-white">;</span></div>
          </div>

          {/* Result preview */}
          <div className="mt-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Query executed in 23ms • 847 rows returned
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ gradient, title, description, icon }: {
  gradient: string;
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <div className={`p-6 rounded-2xl border border-white/10 bg-gradient-to-br ${gradient} backdrop-blur-sm hover:border-white/20 transition-colors`}>
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="text-xl font-semibold mb-2">{title}</h3>
      <p className="text-zinc-400 text-sm leading-relaxed">{description}</p>
    </div>
  );
}

function CompetitorCard({ name, issue }: { name: string; issue: string }) {
  return (
    <div className="p-4">
      <div className="text-lg font-semibold mb-2">{name}</div>
      <div className="text-sm text-zinc-500">{issue}</div>
    </div>
  );
}

function MakoIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 102 90" fill="currentColor" className={className}>
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
