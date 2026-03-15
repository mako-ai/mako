"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, useEffect } from "react";

// Main landing page - Gradient Hero design
export default function Home() {
  const [theme, setTheme] = useState<"dark" | "light" | "system">("system");
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 0);
    };
    handleScroll();
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      if (theme === "system") {
        root.classList.toggle("dark", mediaQuery.matches);
      } else {
        root.classList.toggle("dark", theme === "dark");
      }
    };

    applyTheme();

    // Listen for system preference changes when in "system" mode
    const handleChange = () => {
      if (theme === "system") {
        applyTheme();
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  return (
    <div className="min-h-screen bg-white dark:bg-black text-zinc-900 dark:text-white overflow-hidden">
      {/* Gradient Background */}
      <div className="fixed inset-0 pointer-events-none dark:opacity-100 opacity-30">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-zinc-400/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-500/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-1/2 w-[800px] h-[400px] bg-zinc-400/20 rounded-full blur-[120px]" />
      </div>

      {/* Navigation - Sticky with blur on scroll */}
      <nav
        className={`fixed top-0 w-full z-50 transition-all duration-300 ${
          isScrolled
            ? "bg-white/70 dark:bg-black/70 backdrop-blur-xl border-b border-zinc-200/50 dark:border-white/10"
            : "border-b border-transparent"
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-10">
            <Link href="/" className="flex items-center gap-2">
              <MakoIcon className="w-7 h-7" />
              <span className="font-bold text-xl">mako</span>
            </Link>
            <div className="hidden md:flex items-center gap-8 text-sm text-zinc-500 dark:text-zinc-400">
              <Link
                href="#features"
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
          {/* Double button nav from v1 */}
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

      {/* Hero */}
      <section className="relative z-10 pt-32 pb-20 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-zinc-200 dark:border-white/10 bg-white/50 dark:bg-white/5 text-sm mb-8 backdrop-blur-sm">
            <span className="px-2 py-0.5 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-medium">
              NEW
            </span>
            <span className="text-zinc-600 dark:text-zinc-300">
              AI for database queries
            </span>
          </div>

          <h1 className="text-6xl md:text-8xl font-bold tracking-tight mb-8 leading-[0.9]">
            <span className="block">Query databases</span>
            <span className="block bg-gradient-to-r from-zinc-600 via-zinc-500 to-zinc-400 dark:from-zinc-300 dark:via-zinc-400 dark:to-zinc-500 bg-clip-text text-transparent">
              with superpowers
            </span>
          </h1>

          <p className="text-xl md:text-2xl text-zinc-500 dark:text-zinc-400 max-w-3xl mx-auto mb-12 leading-relaxed">
            Mako is an AI-native SQL client that generates queries from your
            schema, helps teams collaborate, and turns queries into APIs—right
            in your browser.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <a
              href="https://app.mako.ai"
              className="group w-full sm:w-auto px-8 py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-semibold rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors flex items-center justify-center gap-2"
            >
              Start Building Free
              <svg
                className="w-4 h-4 group-hover:translate-x-1 transition-transform"
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
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-8 py-4 border border-zinc-300 dark:border-white/20 font-semibold rounded-lg hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              Star on GitHub
            </a>
          </div>

          {/* Animated Query Demo */}
          <QueryDemo />
        </div>
      </section>

      {/* Bento Grid from v5 */}
      <section id="features" className="relative z-10 py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-6">
              Works with your favorite databases
            </p>
            <div className="flex flex-wrap items-start justify-center gap-6 md:gap-8 mb-16">
              <DatabaseLogo name="PostgreSQL" icon="/icons/postgresql.svg" />
              <DatabaseLogo name="MySQL" icon="/icons/mysql.svg" />
              <DatabaseLogo name="MongoDB" icon="/icons/mongodb.svg" />
              <DatabaseLogo name="BigQuery" icon="/icons/bigquery.svg" />
              <DatabaseLogo name="Snowflake" icon="/icons/snowflake.svg" />
              <DatabaseLogo name="Clickhouse" icon="/icons/clickhouse.svg" />
            </div>
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Why developers love Mako
            </h2>
            <p className="text-xl text-zinc-500 dark:text-zinc-400">
              Everything you need to work with databases, nothing you
              don&apos;t.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* AI Card - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-zinc-200/80 via-zinc-100 dark:from-zinc-800/80 dark:via-zinc-900 to-zinc-100 dark:to-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="flex flex-col h-full">
                <div className="text-4xl mb-4">✨</div>
                <h3 className="text-2xl font-bold mb-2">AI Query Generation</h3>
                <p className="text-zinc-500 dark:text-zinc-400 mb-6 flex-grow">
                  Ask in plain English. Mako uses your schema to generate a
                  query you can run and iterate on.
                </p>
                <div className="p-4 rounded-xl bg-white/50 dark:bg-zinc-900/80 font-mono text-sm">
                  <div className="text-zinc-400 dark:text-zinc-500 mb-2">
                    # Ask anything
                  </div>
                  <div className="text-zinc-700 dark:text-zinc-300">
                    &quot;Show me users who haven&apos;t logged in for 30
                    days&quot;
                  </div>
                  <div className="text-zinc-400 dark:text-zinc-500 mt-4">
                    ↓ AI generates
                  </div>
                  <div className="text-emerald-600 dark:text-emerald-400 mt-2">
                    SELECT * FROM users
                    <br />
                    WHERE last_login &lt; NOW() - INTERVAL &apos;30 days&apos;;
                  </div>
                </div>
              </div>
            </div>

            {/* Open Source Card */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">💚</div>
              <h3 className="text-xl font-bold mb-2">Open Source</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                MIT licensed. Self-host it, fork it, customize it. Your data
                stays yours.
              </p>
              <div className="mt-6 flex items-center gap-2">
                <GitHubIcon className="w-5 h-5 text-zinc-400 dark:text-zinc-500" />
                <span className="text-sm text-zinc-400 dark:text-zinc-500">
                  github.com/mako-ai/mono
                </span>
              </div>
            </div>

            {/* Collaboration Card */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">👥</div>
              <h3 className="text-xl font-bold mb-2">Team Collaboration</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Share database connections securely. Version control your SQL
                snippets. Work together in real-time.
              </p>
              <div className="mt-6 flex -space-x-2">
                <div className="w-8 h-8 rounded-full bg-zinc-700 border-2 border-zinc-100 dark:border-zinc-900" />
                <div className="w-8 h-8 rounded-full bg-zinc-500 border-2 border-zinc-100 dark:border-zinc-900" />
                <div className="w-8 h-8 rounded-full bg-zinc-400 border-2 border-zinc-100 dark:border-zinc-900" />
                <div className="w-8 h-8 rounded-full bg-zinc-300 dark:bg-zinc-700 border-2 border-zinc-100 dark:border-zinc-900 flex items-center justify-center text-xs">
                  +5
                </div>
              </div>
            </div>

            {/* Cloud Card */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">☁️</div>
              <h3 className="text-xl font-bold mb-2">Nothing to Install</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Runs in your browser. No downloads or setup. Open it and start
                querying.
              </p>
            </div>

            {/* Free Card */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">🆓</div>
              <h3 className="text-xl font-bold mb-2">Free Forever</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Free to use. No credit card.
              </p>
              <div className="mt-6">
                <span className="px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-sm">
                  $0/month
                </span>
              </div>
            </div>

            {/* Autocomplete Card */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">💡</div>
              <h3 className="text-xl font-bold mb-2">Smart Autocomplete</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Context-aware suggestions for tables, columns, and functions.
                Write queries faster with intelligent code completion.
              </p>
            </div>

            {/* API Card - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-zinc-200/80 via-zinc-100 dark:from-zinc-800/80 dark:via-zinc-900 to-zinc-100 dark:to-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="grid md:grid-cols-2 gap-8 h-full">
                <div>
                  <div className="text-4xl mb-4">⚡</div>
                  <h3 className="text-2xl font-bold mb-2">One-Click APIs</h3>
                  <p className="text-zinc-500 dark:text-zinc-400">
                    Turn any query into a REST endpoint instantly. Perfect for
                    dashboards, internal tools, and prototypes.
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-white/50 dark:bg-zinc-900/80 font-mono text-sm">
                  <div className="text-zinc-400 dark:text-zinc-500">
                    GET /api/v1/revenue
                  </div>
                  <div className="mt-4 text-zinc-700 dark:text-zinc-300">
                    {`{`}
                    <br />
                    &nbsp;&nbsp;&quot;data&quot;: [...],
                    <br />
                    &nbsp;&nbsp;&quot;count&quot;: 847,
                    <br />
                    &nbsp;&nbsp;&quot;cached&quot;: true
                    <br />
                    {`}`}
                  </div>
                </div>
              </div>
            </div>

            {/* Blazing Fast Card - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-zinc-200/80 via-zinc-100 dark:from-zinc-800/80 dark:via-zinc-900 to-zinc-100 dark:to-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="grid md:grid-cols-2 gap-8 h-full">
                <div>
                  <div className="text-4xl mb-4">🚀</div>
                  <h3 className="text-2xl font-bold mb-2">Blazing Fast</h3>
                  <p className="text-zinc-500 dark:text-zinc-400">
                    Fast to open, smooth to use—built to stay lightweight.
                  </p>
                </div>
                <div className="flex flex-col justify-center gap-4">
                  <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold text-zinc-900 dark:text-white">
                      &lt;1s
                    </span>
                    <span className="text-zinc-400 dark:text-zinc-500">
                      startup time
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold text-zinc-900 dark:text-white">
                      60fps
                    </span>
                    <span className="text-zinc-400 dark:text-zinc-500">
                      smooth scrolling
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold text-zinc-900 dark:text-white">
                      0MB
                    </span>
                    <span className="text-zinc-400 dark:text-zinc-500">
                      disk space
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Keyboard First */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">⌨️</div>
              <h3 className="text-xl font-bold mb-2">Keyboard-First</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Cmd+K command palette, vim bindings, shortcuts for everything.
                Built for developers who live in the keyboard.
              </p>
              <div className="mt-6 flex gap-2">
                <kbd className="px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded text-xs">
                  ⌘K
                </kbd>
                <kbd className="px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded text-xs">
                  ⌘↵
                </kbd>
                <kbd className="px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded text-xs">
                  ⌘S
                </kbd>
              </div>
            </div>

            {/* Query History */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">📜</div>
              <h3 className="text-xl font-bold mb-2">Query History</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Every query saved and synced across devices. Full-text search
                your history. Never lose your work again.
              </p>
            </div>

            {/* Security Card */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">🔒</div>
              <h3 className="text-xl font-bold mb-2">Enterprise Security</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Credentials encrypted at rest. Audit logs. Data masking for PII.
                Self-host for full control.
              </p>
            </div>

            {/* Query Scheduling */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">⏰</div>
              <h3 className="text-xl font-bold mb-2">Query Scheduling</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Schedule recurring queries. Get results via Slack, email, or
                webhook. Set it and forget it.
              </p>
            </div>

            {/* Visual EXPLAIN */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">📊</div>
              <h3 className="text-xl font-bold mb-2">Visual EXPLAIN</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                See exactly how your queries run. Identify slow operations.
                Optimize performance with visual execution plans.
              </p>
            </div>

            {/* Export Options */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">📤</div>
              <h3 className="text-xl font-bold mb-2">Export Anywhere</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Export to CSV, JSON, Excel. Create shareable links. Build charts
                from your results.
              </p>
              <div className="mt-6 flex gap-2">
                <span className="px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded text-xs text-zinc-500 dark:text-zinc-400">
                  .csv
                </span>
                <span className="px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded text-xs text-zinc-500 dark:text-zinc-400">
                  .json
                </span>
                <span className="px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded text-xs text-zinc-500 dark:text-zinc-400">
                  .xlsx
                </span>
              </div>
            </div>

            {/* Dark Mode */}
            <div className="p-8 rounded-3xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="text-4xl mb-4">🌙</div>
              <h3 className="text-xl font-bold mb-2">Dark Mode</h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">
                Easy on the eyes during late-night debugging sessions.
                Automatically syncs with your system preferences.
              </p>
            </div>

            {/* SSH Tunneling - Full Width */}
            <div className="lg:col-span-3 p-8 rounded-3xl bg-gradient-to-br from-zinc-200/80 via-zinc-100 dark:from-zinc-800/80 dark:via-zinc-900 to-zinc-100 dark:to-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="grid md:grid-cols-2 gap-8 h-full">
                <div>
                  <div className="text-4xl mb-4">🔐</div>
                  <h3 className="text-2xl font-bold mb-2">
                    SSH Tunneling Made Easy
                  </h3>
                  <p className="text-zinc-500 dark:text-zinc-400">
                    Connect to databases behind firewalls with one-click setup.
                    No terminal commands, no config files, no headaches.
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-white/50 dark:bg-zinc-900/80 font-mono text-sm flex flex-col justify-center">
                  <div className="text-zinc-400 dark:text-zinc-500 mb-2">
                    # Before (terminal hell)
                  </div>
                  <div className="text-red-500 dark:text-red-400 line-through text-xs mb-4">
                    ssh -L 5432:db:5432 bastion...
                  </div>
                  <div className="text-zinc-400 dark:text-zinc-500 mb-2">
                    # Now (one click)
                  </div>
                  <div className="text-emerald-600 dark:text-emerald-400">
                    ✓ SSH tunnel connected
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison Table from v1 */}
      <section className="relative z-10 py-24 px-6 border-t border-zinc-200 dark:border-white/10">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-4">
            How Mako compares
          </h2>
          <p className="text-xl text-zinc-500 dark:text-zinc-400 text-center mb-16">
            See how we compare to the alternatives.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left py-4 px-4 font-medium text-zinc-400">
                    Feature
                  </th>
                  <th className="text-center py-4 px-4 font-bold">Mako</th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-400">
                    DataGrip
                  </th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-400">
                    DBeaver
                  </th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-400">
                    Postico
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-300">
                <ComparisonRow
                  label="AI Query Generation"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Web-Based"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Team Collaboration"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="One-Click APIs"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Free & Open Source"
                  mako={true}
                  datagrip={false}
                  dbeaver="partial"
                  postico={false}
                />
                <ComparisonRow
                  label="No Installation"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Query History Sync"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Instant Startup"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={true}
                />
                <ComparisonRow
                  label="Visual EXPLAIN Plans"
                  mako={true}
                  datagrip={true}
                  dbeaver="partial"
                  postico={false}
                />
                <ComparisonRow
                  label="Query Scheduling"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Data Masking (PII)"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
                <ComparisonRow
                  label="Audit Logs"
                  mako={true}
                  datagrip={false}
                  dbeaver={false}
                  postico={false}
                />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Star Wars Testimonials */}
      <section className="relative z-10 py-24 px-6 border-t border-zinc-200 dark:border-white/10">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-4xl font-bold text-center mb-4">
            What the galaxy is saying
          </h2>
          <p className="text-xl text-zinc-500 dark:text-zinc-400 text-center mb-12">
            Fun quotes for now—real customer stories coming soon.
          </p>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <TestimonialCard
              quote="Finally, a SQL client faster than the Millennium Falcon. Made the Kessel Run in less than 12 parsecs... I mean queries."
              author="Han Solo"
              role="Professional Smuggler"
              company="Rebel Alliance"
            />
            <TestimonialCard
              quote="RRWWWGG RRWWWGG! (Translation: The AI understands my schema better than C-3PO understands me.)"
              author="Chewbacca"
              role="Co-Pilot & Mechanic"
              company="Millennium Falcon LLC"
            />
            <TestimonialCard
              quote="In my day, we had to write SQL by hand, uphill both ways. This AI generation... impressive. Most impressive."
              author="Darth Vader"
              role="Dark Lord of the Sith"
              company="Galactic Empire"
            />
            <TestimonialCard
              quote="Judge me by my query size, do you? With Mako, even small queries, powerful results bring."
              author="Yoda"
              role="Jedi Master (Retired)"
              company="Dagobah Swamp Consulting"
            />
            <TestimonialCard
              quote="I find your lack of collaboration features disturbing... oh wait, Mako has those. Carry on."
              author="Grand Moff Tarkin"
              role="Regional Governor"
              company="Death Star Operations"
            />
            <TestimonialCard
              quote="Help me Mako, you're my only hope! These DataGrip license fees are destroying the Rebel Alliance budget."
              author="Princess Leia"
              role="Senator & General"
              company="New Republic"
            />
          </div>
        </div>
      </section>

      {/* CTA with View Source button from v6 */}
      <section className="relative z-10 py-24 px-6 border-t border-zinc-200 dark:border-white/10">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-5xl md:text-6xl font-bold mb-6">
            Ready to query smarter?
          </h2>
          <p className="text-xl text-zinc-500 dark:text-zinc-400 mb-10">
            Join developers who&apos;ve upgraded their database workflow.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-10 py-5 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-bold text-lg rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
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
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-10 py-5 border border-zinc-300 dark:border-zinc-700 font-bold text-lg rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              View Source
            </a>
          </div>
        </div>
      </section>

      {/* Footer with Theme Toggle */}
      <footer className="relative z-10 py-12 px-6 border-t border-zinc-200 dark:border-white/10">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-400 text-sm">
              © 2025 Mako. Open source under MIT.
            </span>
          </div>

          {/* Theme Toggle */}
          <div className="flex items-center gap-2 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            <button
              onClick={() => setTheme("light")}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                theme === "light"
                  ? "bg-white dark:bg-zinc-700 shadow-sm font-medium"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                theme === "dark"
                  ? "bg-white dark:bg-zinc-700 shadow-sm font-medium"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme("system")}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                theme === "system"
                  ? "bg-white dark:bg-zinc-700 shadow-sm font-medium"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              System
            </button>
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
              href="/blog"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Blog
            </Link>
            <a
              href="#"
              className="hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              Discord
            </a>
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
      setStep(s => (s + 1) % 2);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl overflow-hidden shadow-2xl">
        {/* Window header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            mako — production
          </span>
          <div className="w-16" />
        </div>

        {/* Content */}
        <div className="p-6">
          {/* AI Input */}
          <div className="flex items-center gap-3 p-4 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 border border-zinc-200 dark:border-white/5 mb-6">
            <div className="w-8 h-8 rounded-full bg-zinc-800 dark:bg-zinc-200 flex items-center justify-center text-sm text-white dark:text-zinc-900">
              ✨
            </div>
            <span className="text-zinc-600 dark:text-zinc-300 font-mono text-sm">
              {steps[step].prompt}
              {steps[step].typing && <span className="animate-pulse">|</span>}
            </span>
          </div>

          {/* Generated SQL */}
          <div className="font-mono text-sm text-left">
            <div className="text-zinc-400 dark:text-zinc-500 mb-2">
              -- AI Generated SQL
            </div>
            <div className="text-blue-600 dark:text-blue-400">
              SELECT <span className="text-zinc-800 dark:text-white">*</span>
            </div>
            <div className="text-blue-600 dark:text-blue-400">
              FROM{" "}
              <span className="text-emerald-600 dark:text-emerald-400">
                users
              </span>
            </div>
            <div className="text-blue-600 dark:text-blue-400">
              WHERE{" "}
              <span className="text-zinc-800 dark:text-white">created_at</span>{" "}
              <span className="text-zinc-600 dark:text-zinc-300">&gt;=</span>{" "}
              <span className="text-yellow-600 dark:text-yellow-400">NOW</span>
              <span className="text-zinc-800 dark:text-white">() - </span>
              <span className="text-orange-600 dark:text-orange-400">
                INTERVAL &apos;7 days&apos;
              </span>
            </div>
            <div className="text-blue-600 dark:text-blue-400">
              ORDER BY{" "}
              <span className="text-zinc-800 dark:text-white">created_at</span>{" "}
              <span className="text-blue-600 dark:text-blue-400">DESC</span>
              <span className="text-zinc-800 dark:text-white">;</span>
            </div>
          </div>

          {/* Result preview */}
          <div className="mt-6 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm">
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
              Query executed in 23ms • 847 rows returned
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComparisonRow({
  label,
  mako,
  datagrip,
  dbeaver,
  postico,
}: {
  label: string;
  mako: boolean;
  datagrip: boolean | "partial";
  dbeaver: boolean | "partial";
  postico: boolean | "partial";
}) {
  const Check = () => <span className="text-emerald-500">✓</span>;
  const Cross = () => (
    <span className="text-zinc-300 dark:text-zinc-600">—</span>
  );
  const Partial = () => <span className="text-yellow-500">~</span>;

  const getIcon = (value: boolean | "partial") => {
    if (value === true) return <Check />;
    if (value === "partial") return <Partial />;
    return <Cross />;
  };

  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-800/50">
      <td className="py-4 px-4">{label}</td>
      <td className="text-center py-4 px-4 bg-zinc-100/80 dark:bg-zinc-800/50">
        {getIcon(mako)}
      </td>
      <td className="text-center py-4 px-4">{getIcon(datagrip)}</td>
      <td className="text-center py-4 px-4">{getIcon(dbeaver)}</td>
      <td className="text-center py-4 px-4">{getIcon(postico)}</td>
    </tr>
  );
}

function TestimonialCard({
  quote,
  author,
  role,
  company,
}: {
  quote: string;
  author: string;
  role: string;
  company: string;
}) {
  return (
    <div className="p-6 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:shadow-lg transition-shadow">
      <div className="flex items-center gap-0.5 mb-4">
        {[...Array(5)].map((_, i) => (
          <StarIcon key={i} className="w-4 h-4 text-yellow-400" />
        ))}
      </div>
      <p className="text-zinc-600 dark:text-zinc-300 mb-6">
        &quot;{quote}&quot;
      </p>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-zinc-800 dark:bg-zinc-200 flex items-center justify-center text-white dark:text-zinc-900 text-sm font-bold">
          {author
            .split(" ")
            .map(n => n[0])
            .join("")}
        </div>
        <div>
          <div className="font-medium text-sm">{author}</div>
          <div className="text-zinc-400 dark:text-zinc-500 text-xs">
            {role} at {company}
          </div>
        </div>
      </div>
    </div>
  );
}

function DatabaseLogo({ name, icon }: { name: string; icon: string }) {
  return (
    <div className="flex flex-col items-center gap-2 group">
      <div className="w-14 h-14 md:w-16 md:h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/50 group-hover:border-zinc-300 dark:group-hover:border-zinc-600 group-hover:scale-105 transition-all flex items-center justify-center">
        <Image
          src={icon}
          alt={name}
          width={32}
          height={32}
          className="w-8 h-8 md:w-9 md:h-9"
        />
      </div>
      <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {name}
      </span>
    </div>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
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
