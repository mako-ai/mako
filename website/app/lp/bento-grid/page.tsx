import Link from "next/link";
import Image from "next/image";

// V5: Bento Grid - Modern card-based layout showcasing features
export default function V5BentoGrid() {
  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-neutral-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                <MakoIcon className="w-5 h-5" />
              </div>
              <span className="font-bold text-lg">Mako</span>
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/mako-ai/mono"
              className="text-sm text-neutral-400 hover:text-white transition-colors hidden sm:block"
            >
              GitHub
            </a>
            <a
              href="https://docs.mako.ai"
              className="text-sm text-neutral-400 hover:text-white transition-colors hidden sm:block"
            >
              Docs
            </a>
            <a
              href="https://app.mako.ai"
              className="px-4 py-2 text-sm font-medium bg-white text-black rounded-full hover:bg-neutral-200 transition-colors"
            >
              Open App
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-16 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-sm text-violet-400 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
            Now open source
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            Database queries,
            <br />
            <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
              powered by AI
            </span>
          </h1>

          <p className="text-xl text-neutral-400 max-w-2xl mx-auto mb-10">
            The free, open-source SQL client that writes queries for you.
            Collaborate with your team. Deploy APIs in one click.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold rounded-full hover:opacity-90 transition-opacity"
            >
              Get Started Free
            </a>
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-8 py-3.5 border border-neutral-700 text-white font-semibold rounded-full hover:bg-neutral-800 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Bento Grid */}
      <section className="py-16 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* AI Card - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-violet-500/20 via-neutral-900 to-neutral-900 border border-neutral-800">
              <div className="flex flex-col h-full">
                <div className="text-4xl mb-4">✨</div>
                <h3 className="text-2xl font-bold mb-2">AI Query Generation</h3>
                <p className="text-neutral-400 mb-6 flex-grow">
                  Describe what you need in plain English. Our AI understands
                  your database schema and writes optimized queries that
                  actually work.
                </p>
                <div className="p-4 rounded-xl bg-neutral-900/80 font-mono text-sm">
                  <div className="text-neutral-500 mb-2"># Ask anything</div>
                  <div className="text-violet-400">
                    &quot;Show me users who haven&apos;t logged in for 30
                    days&quot;
                  </div>
                  <div className="text-neutral-500 mt-4">↓ AI generates</div>
                  <div className="text-emerald-400 mt-2">
                    SELECT * FROM users
                    <br />
                    WHERE last_login &lt; NOW() - INTERVAL &apos;30 days&apos;;
                  </div>
                </div>
              </div>
            </div>

            {/* Open Source Card */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">💚</div>
              <h3 className="text-xl font-bold mb-2">Open Source</h3>
              <p className="text-neutral-400 text-sm">
                MIT licensed. Self-host it, fork it, customize it. Your data
                stays yours.
              </p>
              <div className="mt-6 flex items-center gap-2">
                <GitHubIcon className="w-5 h-5 text-neutral-500" />
                <span className="text-sm text-neutral-500">
                  github.com/mako-ai/mono
                </span>
              </div>
            </div>

            {/* Collaboration Card */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">👥</div>
              <h3 className="text-xl font-bold mb-2">Team Collaboration</h3>
              <p className="text-neutral-400 text-sm">
                Share database connections securely. Version control your SQL
                snippets. Work together in real-time.
              </p>
              <div className="mt-6 flex -space-x-2">
                <div className="w-8 h-8 rounded-full bg-pink-500 border-2 border-neutral-900" />
                <div className="w-8 h-8 rounded-full bg-violet-500 border-2 border-neutral-900" />
                <div className="w-8 h-8 rounded-full bg-blue-500 border-2 border-neutral-900" />
                <div className="w-8 h-8 rounded-full bg-neutral-700 border-2 border-neutral-900 flex items-center justify-center text-xs">
                  +5
                </div>
              </div>
            </div>

            {/* API Card - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-fuchsia-500/20 via-neutral-900 to-neutral-900 border border-neutral-800">
              <div className="grid md:grid-cols-2 gap-8 h-full">
                <div>
                  <div className="text-4xl mb-4">⚡</div>
                  <h3 className="text-2xl font-bold mb-2">One-Click APIs</h3>
                  <p className="text-neutral-400">
                    Turn any query into a REST endpoint instantly. Perfect for
                    dashboards, internal tools, and prototypes.
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-neutral-900/80 font-mono text-sm">
                  <div className="text-neutral-500">GET /api/v1/revenue</div>
                  <div className="mt-4 text-fuchsia-400">
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

            {/* Databases Card */}
            <div className="md:col-span-2 lg:col-span-1 p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">🗄️</div>
              <h3 className="text-xl font-bold mb-2">All Your Databases</h3>
              <p className="text-neutral-400 text-sm mb-6">
                PostgreSQL, MySQL, MongoDB, BigQuery, SQLite, and more. One tool
                for everything.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <DatabaseBadge icon="/icons/postgresql.svg" />
                <DatabaseBadge icon="/icons/mysql.svg" />
                <DatabaseBadge icon="/icons/mongodb.svg" />
                <DatabaseBadge icon="/icons/bigquery.svg" />
                <DatabaseBadge icon="/icons/snowflake.svg" />
                <div className="w-10 h-10 rounded-lg bg-neutral-800 flex items-center justify-center text-xs text-neutral-500">
                  +5
                </div>
              </div>
            </div>

            {/* Cloud Card */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">☁️</div>
              <h3 className="text-xl font-bold mb-2">Nothing to Install</h3>
              <p className="text-neutral-400 text-sm">
                Works entirely in your browser. No downloads, no config, no
                updates. Just open and query.
              </p>
            </div>

            {/* Free Card */}
            <div className="p-8 rounded-3xl bg-gradient-to-br from-emerald-500/20 via-neutral-900 to-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">🆓</div>
              <h3 className="text-xl font-bold mb-2">Free Forever</h3>
              <p className="text-neutral-400 text-sm">
                No credit card. No trial period. No feature gates. Just free.
              </p>
              <div className="mt-6">
                <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-sm">
                  $0/month
                </span>
              </div>
            </div>

            {/* Blazing Fast Card - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-orange-500/20 via-neutral-900 to-neutral-900 border border-neutral-800">
              <div className="grid md:grid-cols-2 gap-8 h-full">
                <div>
                  <div className="text-4xl mb-4">🚀</div>
                  <h3 className="text-2xl font-bold mb-2">Blazing Fast</h3>
                  <p className="text-neutral-400">
                    No Java. No Electron bloat. Opens instantly and runs silky
                    smooth. Because your time matters more than waiting for
                    software to load.
                  </p>
                </div>
                <div className="flex flex-col justify-center gap-4">
                  <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold text-orange-400">
                      &lt;1s
                    </span>
                    <span className="text-neutral-500">startup time</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold text-orange-400">
                      60fps
                    </span>
                    <span className="text-neutral-500">smooth scrolling</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-2xl font-bold text-orange-400">
                      0MB
                    </span>
                    <span className="text-neutral-500">disk space</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Keyboard First */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">⌨️</div>
              <h3 className="text-xl font-bold mb-2">Keyboard-First</h3>
              <p className="text-neutral-400 text-sm">
                Cmd+K command palette, vim bindings, shortcuts for everything.
                Built for developers who live in the keyboard.
              </p>
              <div className="mt-6 flex gap-2">
                <kbd className="px-2 py-1 bg-neutral-800 rounded text-xs">
                  ⌘K
                </kbd>
                <kbd className="px-2 py-1 bg-neutral-800 rounded text-xs">
                  ⌘↵
                </kbd>
                <kbd className="px-2 py-1 bg-neutral-800 rounded text-xs">
                  ⌘S
                </kbd>
              </div>
            </div>

            {/* Query History */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">📜</div>
              <h3 className="text-xl font-bold mb-2">Query History</h3>
              <p className="text-neutral-400 text-sm">
                Every query saved and synced across devices. Full-text search
                your history. Never lose your work again.
              </p>
            </div>

            {/* Security Card */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">🔒</div>
              <h3 className="text-xl font-bold mb-2">Enterprise Security</h3>
              <p className="text-neutral-400 text-sm">
                Credentials encrypted at rest. Audit logs. Data masking for PII.
                SOC2 compliant or self-host for full control.
              </p>
            </div>

            {/* SSH Tunneling - Large */}
            <div className="lg:col-span-2 p-8 rounded-3xl bg-gradient-to-br from-cyan-500/20 via-neutral-900 to-neutral-900 border border-neutral-800">
              <div className="grid md:grid-cols-2 gap-8 h-full">
                <div>
                  <div className="text-4xl mb-4">🔐</div>
                  <h3 className="text-2xl font-bold mb-2">
                    SSH Tunneling Made Easy
                  </h3>
                  <p className="text-neutral-400">
                    Connect to databases behind firewalls with one-click setup.
                    No terminal commands, no config files, no headaches.
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-neutral-900/80 font-mono text-sm flex flex-col justify-center">
                  <div className="text-neutral-500 mb-2">
                    # Before (terminal hell)
                  </div>
                  <div className="text-red-400 line-through text-xs mb-4">
                    ssh -L 5432:db:5432 bastion...
                  </div>
                  <div className="text-neutral-500 mb-2"># Now (one click)</div>
                  <div className="text-cyan-400">✓ SSH tunnel connected</div>
                </div>
              </div>
            </div>

            {/* Query Scheduling */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">⏰</div>
              <h3 className="text-xl font-bold mb-2">Query Scheduling</h3>
              <p className="text-neutral-400 text-sm">
                Schedule recurring queries. Get results via Slack, email, or
                webhook. Set it and forget it.
              </p>
            </div>

            {/* Visual EXPLAIN */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">📊</div>
              <h3 className="text-xl font-bold mb-2">Visual EXPLAIN</h3>
              <p className="text-neutral-400 text-sm">
                See exactly how your queries run. Identify slow operations.
                Optimize performance with visual execution plans.
              </p>
            </div>

            {/* Export Options */}
            <div className="p-8 rounded-3xl bg-neutral-900 border border-neutral-800">
              <div className="text-4xl mb-4">📤</div>
              <h3 className="text-xl font-bold mb-2">Export Anywhere</h3>
              <p className="text-neutral-400 text-sm">
                Export to CSV, JSON, Excel. Create shareable links. Build charts
                from your results.
              </p>
              <div className="mt-6 flex gap-2">
                <span className="px-2 py-1 bg-neutral-800 rounded text-xs text-neutral-400">
                  .csv
                </span>
                <span className="px-2 py-1 bg-neutral-800 rounded text-xs text-neutral-400">
                  .json
                </span>
                <span className="px-2 py-1 bg-neutral-800 rounded text-xs text-neutral-400">
                  .xlsx
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Start querying smarter
          </h2>
          <p className="text-xl text-neutral-400 mb-10">
            Join thousands of developers who&apos;ve upgraded their database
            workflow.
          </p>
          <a
            href="https://app.mako.ai"
            className="inline-flex items-center gap-2 px-10 py-4 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-bold rounded-full hover:opacity-90 transition-opacity"
          >
            Open Mako — It&apos;s Free
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
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-neutral-800">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <MakoIcon className="w-4 h-4" />
            </div>
            <span className="text-neutral-400 text-sm">
              © 2025 Mako. MIT License.
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-neutral-400">
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

function DatabaseBadge({ icon }: { icon: string }) {
  return (
    <div className="w-10 h-10 rounded-lg bg-neutral-800 flex items-center justify-center">
      <Image src={icon} alt="" width={20} height={20} className="w-5 h-5" />
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
