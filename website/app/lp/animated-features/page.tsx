"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

// V10: Animated Features - Scroll-triggered animations and modern motion design
export default function V10AnimatedFeatures() {
  return (
    <div className="min-h-screen bg-black text-white overflow-x-hidden">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-black/50 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <MakoIcon className="w-7 h-7" />
            <span className="font-bold text-xl tracking-tight">mako</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
            <Link href="#features" className="hover:text-white transition-colors">Features</Link>
            <Link href="https://github.com/mako-ai/mono" className="hover:text-white transition-colors">GitHub</Link>
            <Link href="https://docs.mako.ai" className="hover:text-white transition-colors">Docs</Link>
          </div>
          <a
            href="https://app.mako.ai"
            className="px-5 py-2 text-sm font-medium bg-white text-black rounded-full hover:bg-zinc-200 transition-colors"
          >
            Launch App
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
        {/* Animated background */}
        <div className="absolute inset-0">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-violet-500/20 rounded-full blur-[150px] animate-pulse" />
          <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-500/20 rounded-full blur-[150px] animate-pulse delay-1000" />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto text-center">
          <AnimatedBadge />

          <h1 className="text-5xl md:text-8xl font-bold tracking-tight mb-8">
            <AnimatedText text="SQL queries" />
            <span className="block mt-2">
              <AnimatedGradientText text="reimagined" />
            </span>
          </h1>

          <p className="text-xl md:text-2xl text-zinc-400 max-w-2xl mx-auto mb-12 animate-fade-in-up delay-500">
            The AI-powered database client that&apos;s free, open source,
            and runs entirely in your browser.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-in-up delay-700">
            <a
              href="https://app.mako.ai"
              className="group w-full sm:w-auto px-8 py-4 bg-white text-black font-semibold rounded-full hover:scale-105 transition-transform flex items-center justify-center gap-2"
            >
              Get Started Free
              <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </a>
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-8 py-4 border border-white/20 text-white font-semibold rounded-full hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              View Source
            </a>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
          <svg className="w-6 h-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-32 px-6">
        <div className="max-w-6xl mx-auto">
          {/* Feature 1 - AI */}
          <AnimatedFeature
            align="left"
            badge="AI-Powered"
            title="Write queries in plain English"
            description="Our AI understands your database schema, relationships, and best practices. Just describe what you need."
            visual={<AIVisual />}
          />

          {/* Feature 2 - Collaboration */}
          <AnimatedFeature
            align="right"
            badge="Collaboration"
            title="Built for teams"
            description="Share database connections securely, collaborate on queries in real-time, and maintain version-controlled SQL snippets."
            visual={<CollabVisual />}
          />

          {/* Feature 3 - APIs */}
          <AnimatedFeature
            align="left"
            badge="One-Click"
            title="Instant API endpoints"
            description="Turn any query into a secure REST API with a single click. Perfect for dashboards and internal tools."
            visual={<APIVisual />}
          />

          {/* Feature 4 - Open Source */}
          <AnimatedFeature
            align="right"
            badge="Open Source"
            title="Free forever"
            description="MIT licensed. Self-host it, fork it, customize it. No vendor lock-in, no feature gates, no surprises."
            visual={<OpenSourceVisual />}
          />
        </div>
      </section>

      {/* Databases */}
      <section className="py-24 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-12">Works with your favorite databases</h2>
          <div className="flex flex-wrap items-center justify-center gap-6">
            {[
              { name: 'PostgreSQL', icon: '/icons/postgresql.svg' },
              { name: 'MySQL', icon: '/icons/mysql.svg' },
              { name: 'MongoDB', icon: '/icons/mongodb.svg' },
              { name: 'BigQuery', icon: '/icons/bigquery.svg' },
              { name: 'Snowflake', icon: '/icons/snowflake.svg' },
              { name: 'ClickHouse', icon: '/icons/clickhouse.svg' },
            ].map((db, i) => (
              <DatabaseCard key={db.name} name={db.name} icon={db.icon} delay={i * 100} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-32 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-5xl md:text-6xl font-bold mb-6">
            Ready to level up?
          </h2>
          <p className="text-xl text-zinc-400 mb-12">
            Join developers who&apos;ve upgraded their database workflow.
          </p>
          <a
            href="https://app.mako.ai"
            className="inline-flex items-center gap-2 px-12 py-5 bg-gradient-to-r from-violet-500 to-blue-500 text-white font-bold text-lg rounded-full hover:scale-105 transition-transform"
          >
            Get Started Free
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-400 text-sm">© 2025 Mako. MIT License.</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-400">
            <a href="https://github.com/mako-ai/mono" className="hover:text-white transition-colors">GitHub</a>
            <a href="https://docs.mako.ai" className="hover:text-white transition-colors">Docs</a>
            <a href="#" className="hover:text-white transition-colors">Discord</a>
          </div>
        </div>
      </footer>

      <style jsx>{`
        @keyframes fade-in-up {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in-up {
          animation: fade-in-up 0.6s ease-out forwards;
          opacity: 0;
        }
        .delay-500 {
          animation-delay: 0.5s;
        }
        .delay-700 {
          animation-delay: 0.7s;
        }
        .delay-1000 {
          animation-delay: 1s;
        }
      `}</style>
    </div>
  );
}

function AnimatedBadge() {
  return (
    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/5 mb-8 animate-fade-in-up">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      <span className="text-sm text-zinc-400">Free &amp; Open Source</span>
    </div>
  );
}

function AnimatedText({ text }: { text: string }) {
  return (
    <span className="inline-block animate-fade-in-up">{text}</span>
  );
}

function AnimatedGradientText({ text }: { text: string }) {
  return (
    <span className="inline-block bg-gradient-to-r from-violet-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent animate-fade-in-up delay-300">
      {text}
    </span>
  );
}

function AnimatedFeature({ align, badge, title, description, visual }: {
  align: 'left' | 'right';
  badge: string;
  title: string;
  description: string;
  visual: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.2 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`flex flex-col ${align === 'right' ? 'lg:flex-row-reverse' : 'lg:flex-row'} items-center gap-12 lg:gap-20 py-20 transition-all duration-1000 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}
    >
      <div className="flex-1 text-center lg:text-left">
        <div className="inline-flex items-center px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-sm mb-4">
          {badge}
        </div>
        <h3 className="text-3xl md:text-4xl font-bold mb-4">{title}</h3>
        <p className="text-xl text-zinc-400 leading-relaxed">{description}</p>
      </div>
      <div className="flex-1 w-full max-w-lg">
        {visual}
      </div>
    </div>
  );
}

function AIVisual() {
  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-zinc-900/50">
      <div className="flex items-center gap-3 p-4 rounded-xl bg-violet-500/10 border border-violet-500/20 mb-4">
        <span className="text-2xl">✨</span>
        <span className="text-zinc-300">Find users who churned last month</span>
      </div>
      <div className="p-4 rounded-xl bg-black/50 font-mono text-sm">
        <span className="text-blue-400">SELECT</span>
        <span className="text-white"> * </span>
        <span className="text-blue-400">FROM</span>
        <span className="text-emerald-400"> users</span>
        <br />
        <span className="text-blue-400">WHERE</span>
        <span className="text-white"> churned_at </span>
        <span className="text-pink-400">&gt;=</span>
        <span className="text-yellow-400"> NOW</span>
        <span className="text-white">() - </span>
        <span className="text-orange-400">INTERVAL &apos;30 days&apos;</span>
        <span className="text-white">;</span>
      </div>
    </div>
  );
}

function CollabVisual() {
  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-zinc-900/50">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex -space-x-2">
          <div className="w-8 h-8 rounded-full bg-pink-500 border-2 border-zinc-900" />
          <div className="w-8 h-8 rounded-full bg-violet-500 border-2 border-zinc-900" />
          <div className="w-8 h-8 rounded-full bg-blue-500 border-2 border-zinc-900" />
        </div>
        <span className="text-zinc-400 text-sm">3 team members editing</span>
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2 p-2 rounded bg-white/5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-zinc-400">revenue-report.sql</span>
          <span className="ml-auto text-xs text-zinc-600">Updated 2m ago</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded bg-white/5">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="text-zinc-400">user-analytics.sql</span>
          <span className="ml-auto text-xs text-zinc-600">Updated 5m ago</span>
        </div>
      </div>
    </div>
  );
}

function APIVisual() {
  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-zinc-900/50 font-mono text-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 text-xs">GET</span>
        <span className="text-zinc-400">/api/v1/revenue</span>
      </div>
      <div className="p-4 rounded-xl bg-black/50">
        <span className="text-zinc-500">{`{`}</span>
        <br />
        <span className="text-blue-400 ml-4">&quot;data&quot;</span>
        <span className="text-white">: [...],</span>
        <br />
        <span className="text-blue-400 ml-4">&quot;count&quot;</span>
        <span className="text-white">: </span>
        <span className="text-orange-400">847</span>
        <span className="text-white">,</span>
        <br />
        <span className="text-blue-400 ml-4">&quot;cached&quot;</span>
        <span className="text-white">: </span>
        <span className="text-emerald-400">true</span>
        <br />
        <span className="text-zinc-500">{`}`}</span>
      </div>
    </div>
  );
}

function OpenSourceVisual() {
  return (
    <div className="p-6 rounded-2xl border border-white/10 bg-zinc-900/50 text-center">
      <GitHubIcon className="w-16 h-16 mx-auto mb-4 text-zinc-600" />
      <div className="text-2xl font-bold mb-2">MIT License</div>
      <div className="text-zinc-400">Free forever. Self-host anywhere.</div>
      <div className="mt-4 flex items-center justify-center gap-4">
        <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-zinc-400">
          ⭐ 2.4k stars
        </div>
        <div className="px-3 py-1 rounded-full bg-white/5 text-xs text-zinc-400">
          🍴 320 forks
        </div>
      </div>
    </div>
  );
}

function DatabaseCard({ name, icon, delay }: { name: string; icon: string; delay: number }) {
  return (
    <div
      className="p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-all hover:scale-105"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-3">
        <Image src={icon} alt={name} width={32} height={32} className="w-8 h-8" />
        <span className="font-medium">{name}</span>
      </div>
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
