import Link from "next/link";

// V1: Minimal Dark - Cursor/Linear inspired ultra-clean design
export default function V1MinimalDark() {
  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-[#0A0A0B]/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <MakoIcon className="w-6 h-6" />
              <span className="font-semibold text-lg">Mako</span>
            </Link>
            <div className="hidden md:flex items-center gap-6 text-sm text-zinc-400">
              <Link
                href="#features"
                className="hover:text-white transition-colors"
              >
                Features
              </Link>
              <Link
                href="#pricing"
                className="hover:text-white transition-colors"
              >
                Pricing
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
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://app.mako.ai"
              className="text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Sign in
            </a>
            <a
              href="https://app.mako.ai"
              className="px-4 py-2 text-sm font-medium bg-white text-black rounded-lg hover:bg-zinc-200 transition-colors"
            >
              Get Started
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm mb-8">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Free &amp; Open Source
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            The SQL client
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-violet-400 to-purple-400 bg-clip-text text-transparent">
              that writes itself
            </span>
          </h1>

          <p className="text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Stop wrestling with complex queries. Describe what you need in plain
            English and let AI agents write, optimize, and execute your SQL.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-3 bg-white text-black font-medium rounded-lg hover:bg-zinc-200 transition-colors"
            >
              Start for free
            </a>
            <a
              href="https://github.com/mako-ai/mako"
              className="w-full sm:w-auto px-8 py-3 border border-zinc-800 text-white font-medium rounded-lg hover:bg-zinc-900 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Code Preview */}
      <section className="pb-20 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden shadow-2xl">
            {/* Window controls */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
              </div>
              <div className="flex-1 text-center">
                <span className="text-xs text-zinc-500">
                  mako — production-db
                </span>
              </div>
            </div>

            {/* Editor content */}
            <div className="p-6 font-mono text-sm">
              <div className="flex gap-4 mb-4">
                <span className="text-zinc-600">1</span>
                <span className="text-zinc-400">
                  <span className="text-purple-400">-- Ask:</span> Show me the
                  top 10 customers by revenue this month
                </span>
              </div>
              <div className="flex gap-4 mb-4">
                <span className="text-zinc-600">2</span>
                <span className="text-zinc-500">-- AI generated query:</span>
              </div>
              <div className="flex gap-4 mb-1">
                <span className="text-zinc-600">3</span>
                <span>
                  <span className="text-blue-400">SELECT</span>
                  <span className="text-white"> c.name, </span>
                  <span className="text-yellow-400">SUM</span>
                  <span className="text-white">(o.amount) </span>
                  <span className="text-blue-400">AS</span>
                  <span className="text-white"> revenue</span>
                </span>
              </div>
              <div className="flex gap-4 mb-1">
                <span className="text-zinc-600">4</span>
                <span>
                  <span className="text-blue-400">FROM</span>
                  <span className="text-emerald-400"> customers</span>
                  <span className="text-white"> c</span>
                </span>
              </div>
              <div className="flex gap-4 mb-1">
                <span className="text-zinc-600">5</span>
                <span>
                  <span className="text-blue-400">JOIN</span>
                  <span className="text-emerald-400"> orders</span>
                  <span className="text-white"> o </span>
                  <span className="text-blue-400">ON</span>
                  <span className="text-white"> c.id = o.customer_id</span>
                </span>
              </div>
              <div className="flex gap-4 mb-1">
                <span className="text-zinc-600">6</span>
                <span>
                  <span className="text-blue-400">WHERE</span>
                  <span className="text-white"> o.created_at &gt;= </span>
                  <span className="text-yellow-400">DATE_TRUNC</span>
                  <span className="text-white">(</span>
                  <span className="text-orange-400">&apos;month&apos;</span>
                  <span className="text-white">, </span>
                  <span className="text-yellow-400">NOW</span>
                  <span className="text-white">())</span>
                </span>
              </div>
              <div className="flex gap-4 mb-1">
                <span className="text-zinc-600">7</span>
                <span>
                  <span className="text-blue-400">GROUP BY</span>
                  <span className="text-white"> c.id, c.name</span>
                </span>
              </div>
              <div className="flex gap-4 mb-4">
                <span className="text-zinc-600">8</span>
                <span>
                  <span className="text-blue-400">ORDER BY</span>
                  <span className="text-white"> revenue </span>
                  <span className="text-blue-400">DESC LIMIT</span>
                  <span className="text-orange-400"> 10</span>
                  <span className="text-white">;</span>
                </span>
              </div>
              <div className="flex gap-4">
                <span className="text-zinc-600">9</span>
                <span className="inline-flex items-center gap-2">
                  <span className="w-2 h-4 bg-blue-400 animate-pulse" />
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pain Points */}
      <section className="py-20 px-6 border-t border-zinc-800">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">
            Tired of clunky SQL clients?
          </h2>
          <p className="text-zinc-400 text-center mb-12 max-w-2xl mx-auto">
            We were too. That&apos;s why we built Mako.
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            <PainPointCard
              pain="Slow startup times"
              solution="Opens instantly in your browser. No Java, no Electron bloat."
            />
            <PainPointCard
              pain="$199/year for DataGrip"
              solution="Free forever. No credit card, no trial, no feature gates."
            />
            <PainPointCard
              pain="Different clients for each database"
              solution="One tool for PostgreSQL, MySQL, MongoDB, BigQuery, and more."
            />
            <PainPointCard
              pain="Can't share queries with your team"
              solution="Built-in collaboration. Shared connections, version-controlled snippets."
            />
            <PainPointCard
              pain="Writing SQL from scratch"
              solution="AI writes your queries. Just describe what you need."
            />
            <PainPointCard
              pain="Need to install on every machine"
              solution="Web-based. Access from anywhere, any device."
            />
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-6 border-t border-zinc-800">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">
            Everything you need. Nothing you don&apos;t.
          </h2>
          <p className="text-zinc-400 text-center mb-16 max-w-2xl mx-auto">
            A modern database client built for the AI era. Connect to any
            database, collaborate with your team, and ship faster.
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard
              icon={<BrainIcon />}
              title="AI-Powered Queries"
              description="Describe what you want in plain English. Our AI agents understand your schema and write optimized queries."
            />
            <FeatureCard
              icon={<UsersIcon />}
              title="Team Collaboration"
              description="Shared database connections, version-controlled query snippets, and real-time collaboration."
            />
            <FeatureCard
              icon={<ApiIcon />}
              title="Instant APIs"
              description="Turn any query into a REST endpoint with one click. Perfect for prototyping and internal tools."
            />
            <FeatureCard
              icon={<CloudIcon />}
              title="Nothing to Install"
              description="Works entirely in your browser. No downloads, no config, no hassle. Just connect and query."
            />
            <FeatureCard
              icon={<OpenSourceIcon />}
              title="Open Source"
              description="MIT licensed. Self-host for free, or use our cloud version. Your data, your choice."
            />
            <FeatureCard
              icon={<DatabaseIcon />}
              title="Multi-Database"
              description="PostgreSQL, MySQL, MongoDB, BigQuery, and more. One tool for all your databases."
            />
            <FeatureCard
              icon={<KeyboardIcon />}
              title="Keyboard-First"
              description="Cmd+K command palette, vim keybindings, and shortcuts for everything. Built for power users."
            />
            <FeatureCard
              icon={<HistoryIcon />}
              title="Query History"
              description="Every query you run is saved and synced across devices. Never lose your work again."
            />
            <FeatureCard
              icon={<LockIcon />}
              title="Enterprise Security"
              description="Credentials encrypted at rest, audit logs, data masking for PII, and SOC2 compliance."
            />
            <FeatureCard
              icon={<ChartIcon />}
              title="Visual Results"
              description="Beautiful charts and graphs from your query results. Export to CSV, JSON, or shareable links."
            />
            <FeatureCard
              icon={<TerminalIcon />}
              title="SSH Tunneling"
              description="Connect to databases behind firewalls with one-click SSH tunnel setup. No terminal needed."
            />
            <FeatureCard
              icon={<ClockIcon />}
              title="Query Scheduling"
              description="Schedule recurring queries and get results via Slack, email, or webhook. Set it and forget it."
            />
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="py-20 px-6 border-t border-zinc-800">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-16">
            Why developers choose Mako
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left py-4 px-4 font-medium text-zinc-400">
                    Feature
                  </th>
                  <th className="text-center py-4 px-4 font-bold text-white">
                    Mako
                  </th>
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
              <tbody className="text-zinc-300">
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

      {/* CTA */}
      <section className="py-20 px-6 border-t border-zinc-800">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-6">Ready to query smarter?</h2>
          <p className="text-xl text-zinc-400 mb-8">
            Join thousands of developers who&apos;ve upgraded their database
            workflow.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-3 bg-white text-black font-medium rounded-lg hover:bg-zinc-200 transition-colors"
            >
              Start for free
            </a>
            <a
              href="https://github.com/mako-ai/mako"
              className="w-full sm:w-auto px-8 py-3 border border-zinc-800 text-white font-medium rounded-lg hover:bg-zinc-900 transition-colors"
            >
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-zinc-800">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-400 text-sm">
              © 2025 Mako. Open source under MIT.
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-400">
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
              Twitter
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/50 transition-colors">
      <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-400 mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-zinc-400 text-sm leading-relaxed">{description}</p>
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
  const Check = () => <span className="text-emerald-400">✓</span>;
  const Cross = () => <span className="text-zinc-600">—</span>;
  const Partial = () => <span className="text-yellow-400">~</span>;

  const getIcon = (value: boolean | "partial") => {
    if (value === true) return <Check />;
    if (value === "partial") return <Partial />;
    return <Cross />;
  };

  return (
    <tr className="border-b border-zinc-800/50">
      <td className="py-4 px-4">{label}</td>
      <td className="text-center py-4 px-4 bg-zinc-900/30">{getIcon(mako)}</td>
      <td className="text-center py-4 px-4">{getIcon(datagrip)}</td>
      <td className="text-center py-4 px-4">{getIcon(dbeaver)}</td>
      <td className="text-center py-4 px-4">{getIcon(postico)}</td>
    </tr>
  );
}

// Icons
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

function BrainIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M12 4.5c-1.5-1.5-4-1.5-5.5 0s-1.5 4 0 5.5l5.5 5.5 5.5-5.5c1.5-1.5 1.5-4 0-5.5s-4-1.5-5.5 0" />
      <path d="M12 4.5v11" />
      <path d="M8.5 8h7" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M17.5 19H9a7 7 0 116.71-9h.79a5 5 0 110 10z" />
    </svg>
  );
}

function OpenSourceIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
      <path d="M2 12h20" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function PainPointCard({ pain, solution }: { pain: string; solution: string }) {
  return (
    <div className="p-5 rounded-xl border border-zinc-800 bg-zinc-900/30">
      <div className="flex items-start gap-3">
        <span className="text-red-400 mt-0.5">✗</span>
        <div>
          <div className="text-zinc-400 line-through mb-2">{pain}</div>
          <div className="flex items-start gap-2">
            <span className="text-emerald-400 mt-0.5">✓</span>
            <span className="text-white">{solution}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
