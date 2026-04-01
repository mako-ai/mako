import Link from "next/link";
import Image from "next/image";

// V4: Split Screen - Query editor on left, results visualization on right
export default function V4SplitScreen() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <MakoIcon className="w-7 h-7 text-cyan-400" />
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
                href="#databases"
                className="hover:text-white transition-colors"
              >
                Databases
              </Link>
              <Link
                href="https://docs.mako.ai"
                className="hover:text-white transition-colors"
              >
                Docs
              </Link>
              <Link
                href="https://github.com/mako-ai/mono"
                className="hover:text-white transition-colors"
              >
                GitHub
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://app.mako.ai"
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Sign in
            </a>
            <a
              href="https://app.mako.ai"
              className="px-4 py-2 text-sm font-medium bg-cyan-500 text-slate-950 rounded-lg hover:bg-cyan-400 transition-colors"
            >
              Open App
            </a>
          </div>
        </div>
      </nav>

      {/* Hero - Split Screen */}
      <section className="pt-24 min-h-screen flex items-center">
        <div className="w-full max-w-[1800px] mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-0 items-stretch">
            {/* Left - Text */}
            <div className="flex flex-col justify-center py-12 lg:py-24 lg:pr-16">
              <div className="inline-flex items-center gap-2 px-3 py-1 w-fit rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-sm mb-6">
                Free &amp; Open Source
              </div>

              <h1 className="text-4xl md:text-6xl font-bold leading-tight mb-6">
                The AI-native
                <br />
                <span className="text-cyan-400">SQL client</span>
              </h1>

              <p className="text-xl text-slate-400 mb-8 leading-relaxed max-w-lg">
                Write queries in plain English, collaborate with your team, and
                turn results into APIs—all from your browser.
              </p>

              <div className="flex flex-col sm:flex-row gap-4 mb-12">
                <a
                  href="https://app.mako.ai"
                  className="px-6 py-3 bg-cyan-500 text-slate-950 font-semibold rounded-lg hover:bg-cyan-400 transition-colors text-center"
                >
                  Start Free
                </a>
                <a
                  href="https://github.com/mako-ai/mono"
                  className="px-6 py-3 border border-slate-700 text-white font-semibold rounded-lg hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
                >
                  <GitHubIcon className="w-5 h-5" />
                  View Source
                </a>
              </div>

              {/* Feature Pills */}
              <div className="flex flex-wrap gap-3">
                <FeaturePill icon="✨" text="AI Query Generation" />
                <FeaturePill icon="👥" text="Team Collaboration" />
                <FeaturePill icon="⚡" text="Instant APIs" />
                <FeaturePill icon="☁️" text="Zero Install" />
              </div>
            </div>

            {/* Right - App Preview */}
            <div className="relative lg:border-l border-slate-800 lg:pl-0">
              <div className="sticky top-24">
                <AppPreview />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-24 px-6 border-t border-slate-800">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Built for modern teams</h2>
            <p className="text-xl text-slate-400">
              Everything you need to work with databases, reimagined.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-12">
            <FeatureSection
              title="AI That Understands Your Schema"
              description="Our AI agents introspect your database structure, understand relationships, and generate optimized queries. Just describe what you need."
              features={[
                "Schema-aware query generation",
                "Automatic query optimization",
                "Natural language to SQL",
                "Error correction suggestions",
              ]}
            />
            <FeatureSection
              title="Real-Time Collaboration"
              description="Work together on queries, share database connections securely, and maintain version-controlled SQL snippets."
              features={[
                "Shared database connections",
                "Query version control",
                "Team workspaces",
                "Role-based access control",
              ]}
            />
            <FeatureSection
              title="One-Click API Generation"
              description="Turn any query into a secure REST endpoint instantly. Perfect for dashboards, internal tools, and prototypes."
              features={[
                "Instant REST endpoints",
                "Automatic documentation",
                "Rate limiting built-in",
                "API key management",
              ]}
            />
            <FeatureSection
              title="Works Everywhere"
              description="No downloads, no installations. Works entirely in your browser with support for all major databases."
              features={[
                "100% browser-based",
                "PostgreSQL, MySQL, MongoDB",
                "BigQuery, SQLite, and more",
                "Self-host option available",
              ]}
            />
          </div>
        </div>
      </section>

      {/* Databases */}
      <section id="databases" className="py-24 px-6 border-t border-slate-800">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-4">Connect to any database</h2>
          <p className="text-slate-400 mb-12">
            Works with your existing infrastructure. No migrations required.
          </p>

          <div className="grid grid-cols-3 md:grid-cols-6 gap-8">
            <DatabaseIcon name="PostgreSQL" icon="/icons/postgresql.svg" />
            <DatabaseIcon name="MySQL" icon="/icons/mysql.svg" />
            <DatabaseIcon name="MongoDB" icon="/icons/mongodb.svg" />
            <DatabaseIcon name="BigQuery" icon="/icons/bigquery.svg" />
            <DatabaseIcon name="Snowflake" icon="/icons/snowflake.svg" />
            <DatabaseIcon name="ClickHouse" icon="/icons/clickhouse.svg" />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="p-12 rounded-2xl bg-gradient-to-r from-cyan-500/20 to-blue-500/20 border border-cyan-500/20 text-center">
            <h2 className="text-4xl font-bold mb-4">Ready to try it?</h2>
            <p className="text-xl text-slate-400 mb-8">
              Free forever. No credit card required.
            </p>
            <a
              href="https://app.mako.ai"
              className="inline-flex items-center gap-2 px-8 py-4 bg-cyan-500 text-slate-950 font-bold rounded-lg hover:bg-cyan-400 transition-colors"
            >
              Launch Mako
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
      <footer className="py-12 px-6 border-t border-slate-800">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5 text-cyan-400" />
            <span className="text-slate-400 text-sm">
              © 2025 Mako. MIT License.
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-400">
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

function AppPreview() {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 overflow-hidden shadow-2xl">
      {/* Tab bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/60" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
          <div className="w-3 h-3 rounded-full bg-green-500/60" />
        </div>
        <div className="flex-1 flex items-center justify-center gap-4">
          <div className="px-3 py-1 text-xs bg-slate-700 rounded text-slate-300">
            Query Editor
          </div>
          <div className="px-3 py-1 text-xs text-slate-500">Results</div>
          <div className="px-3 py-1 text-xs text-slate-500">API</div>
        </div>
      </div>

      {/* Split view */}
      <div className="grid grid-cols-1 lg:grid-cols-2 divide-x divide-slate-700">
        {/* Editor */}
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 flex items-center justify-center text-sm">
              ✨
            </div>
            <div className="flex-1 p-2 rounded bg-slate-800 text-sm text-slate-400">
              Show me top customers by revenue this quarter
            </div>
          </div>
          <div className="font-mono text-xs space-y-1">
            <div>
              <span className="text-blue-400">SELECT</span> c.name,{" "}
              <span className="text-yellow-400">SUM</span>(o.total){" "}
              <span className="text-blue-400">AS</span> revenue
            </div>
            <div>
              <span className="text-blue-400">FROM</span>{" "}
              <span className="text-cyan-400">customers</span> c
            </div>
            <div>
              <span className="text-blue-400">JOIN</span>{" "}
              <span className="text-cyan-400">orders</span> o{" "}
              <span className="text-blue-400">ON</span> c.id = o.customer_id
            </div>
            <div>
              <span className="text-blue-400">WHERE</span> o.created_at &gt;={" "}
              <span className="text-orange-400">&apos;2024-10-01&apos;</span>
            </div>
            <div>
              <span className="text-blue-400">GROUP BY</span> c.id{" "}
              <span className="text-blue-400">ORDER BY</span> revenue{" "}
              <span className="text-blue-400">DESC</span>
            </div>
            <div>
              <span className="text-blue-400">LIMIT</span>{" "}
              <span className="text-orange-400">10</span>;
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="p-4 bg-slate-800/50">
          <div className="text-xs text-slate-500 mb-2">
            Results (10 rows • 23ms)
          </div>
          <div className="space-y-1 text-xs font-mono">
            <div className="grid grid-cols-2 gap-4 text-slate-500 border-b border-slate-700 pb-1">
              <span>name</span>
              <span className="text-right">revenue</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <span className="text-slate-300">Acme Corp</span>
              <span className="text-right text-cyan-400">$124,500</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <span className="text-slate-300">TechStart Inc</span>
              <span className="text-right text-cyan-400">$98,200</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <span className="text-slate-300">GlobalFin</span>
              <span className="text-right text-cyan-400">$87,300</span>
            </div>
            <div className="text-slate-600 text-center pt-2">+ 7 more rows</div>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-t border-slate-700 text-xs text-slate-500">
        <span>PostgreSQL • production-db</span>
        <div className="flex items-center gap-4">
          <span className="text-cyan-400">● Connected</span>
          <button className="px-2 py-1 bg-cyan-500/20 text-cyan-400 rounded">
            Run Query
          </button>
        </div>
      </div>
    </div>
  );
}

function FeaturePill({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-sm">
      <span>{icon}</span>
      <span className="text-slate-300">{text}</span>
    </div>
  );
}

function FeatureSection({
  title,
  description,
  features,
}: {
  title: string;
  description: string;
  features: string[];
}) {
  return (
    <div className="p-8 rounded-xl border border-slate-800 bg-slate-900/50">
      <h3 className="text-xl font-bold mb-3">{title}</h3>
      <p className="text-slate-400 mb-6">{description}</p>
      <ul className="space-y-2">
        {features.map((f, i) => (
          <li
            key={i}
            className="flex items-center gap-2 text-sm text-slate-300"
          >
            <svg
              className="w-4 h-4 text-cyan-400"
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
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DatabaseIcon({ name, icon }: { name: string; icon: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-12 h-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center">
        <Image
          src={icon}
          alt={name}
          width={24}
          height={24}
          className="w-6 h-6"
        />
      </div>
      <span className="text-xs text-slate-500">{name}</span>
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
