import Link from "next/link";

// V6: Comparison Table - Direct head-to-head with competitors
export default function V6ComparisonTable() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <MakoIcon className="w-7 h-7" />
              <span className="font-bold text-xl">Mako</span>
            </Link>
            <div className="hidden md:flex items-center gap-6 text-sm text-zinc-500">
              <Link href="#comparison" className="hover:text-zinc-900 dark:hover:text-white transition-colors">Compare</Link>
              <Link href="#features" className="hover:text-zinc-900 dark:hover:text-white transition-colors">Features</Link>
              <Link href="https://docs.mako.ai" className="hover:text-zinc-900 dark:hover:text-white transition-colors">Docs</Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/mako-ai/mono"
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white transition-colors hidden sm:flex items-center gap-1"
            >
              <GitHubIcon className="w-4 h-4" />
              Star
            </a>
            <a
              href="https://app.mako.ai"
              className="px-4 py-2 text-sm font-medium bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-lg hover:opacity-90 transition-opacity"
            >
              Get Started
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="py-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-sm mb-8">
            Free &amp; Open Source Forever
          </div>

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            The SQL client you&apos;ve been
            <span className="block text-emerald-600 dark:text-emerald-400">waiting for</span>
          </h1>

          <p className="text-xl text-zinc-600 dark:text-zinc-400 max-w-2xl mx-auto mb-10">
            Finally, a database client that&apos;s free, AI-powered, web-based, and built for collaboration.
            See how Mako compares to the alternatives.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-3 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-500 transition-colors"
            >
              Try Mako Free
            </a>
            <a
              href="#comparison"
              className="w-full sm:w-auto px-8 py-3 border border-zinc-300 dark:border-zinc-700 font-semibold rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              See Comparison
            </a>
          </div>
        </div>
      </section>

      {/* Comparison Table */}
      <section id="comparison" className="py-20 px-6 bg-zinc-50 dark:bg-zinc-900">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">
            How Mako stacks up
          </h2>
          <p className="text-center text-zinc-600 dark:text-zinc-400 mb-12">
            A detailed comparison with the most popular SQL clients.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="text-left py-4 px-4 font-semibold">Feature</th>
                  <th className="text-center py-4 px-6 font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 rounded-t-xl">
                    <div className="flex items-center justify-center gap-2">
                      <MakoIcon className="w-5 h-5" />
                      Mako
                    </div>
                  </th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-500">DataGrip</th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-500">DBeaver</th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-500">Postico</th>
                  <th className="text-center py-4 px-4 font-medium text-zinc-500">TablePlus</th>
                </tr>
              </thead>
              <tbody>
                <ComparisonSection title="AI & Automation" />
                <ComparisonRow
                  feature="AI Query Generation"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Natural Language Queries"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Schema-Aware AI"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Auto Query Optimization"
                  mako={true}
                  others={["partial", "partial", false, false]}
                />

                <ComparisonSection title="Collaboration" />
                <ComparisonRow
                  feature="Shared Connections"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Team Workspaces"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Query Version Control"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Real-time Collaboration"
                  mako={true}
                  others={[false, false, false, false]}
                />

                <ComparisonSection title="Deployment" />
                <ComparisonRow
                  feature="Web-Based (No Install)"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="One-Click API Generation"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Self-Hosting Option"
                  mako={true}
                  others={[false, true, false, false]}
                />

                <ComparisonSection title="Pricing" />
                <ComparisonRow
                  feature="Free Plan"
                  mako={true}
                  others={[false, true, false, "partial"]}
                />
                <ComparisonRow
                  feature="Open Source"
                  mako={true}
                  others={[false, "partial", false, false]}
                />
                <ComparisonRow
                  feature="No Feature Gates"
                  mako={true}
                  others={[false, false, false, false]}
                />

                <ComparisonSection title="Developer Experience" />
                <ComparisonRow
                  feature="Instant Startup"
                  mako={true}
                  others={[false, false, true, true]}
                />
                <ComparisonRow
                  feature="Keyboard Shortcuts"
                  mako={true}
                  others={[true, true, true, true]}
                />
                <ComparisonRow
                  feature="Vim Keybindings"
                  mako={true}
                  others={[true, "partial", false, false]}
                />
                <ComparisonRow
                  feature="Cmd+K Palette"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Query History Sync"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Monaco Editor"
                  mako={true}
                  others={[false, false, false, false]}
                />

                <ComparisonSection title="Security & Compliance" />
                <ComparisonRow
                  feature="Encrypted Credentials"
                  mako={true}
                  others={[true, true, true, true]}
                />
                <ComparisonRow
                  feature="SSH Tunneling"
                  mako={true}
                  others={[true, true, true, true]}
                />
                <ComparisonRow
                  feature="Data Masking (PII)"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Audit Logs"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Role-Based Access"
                  mako={true}
                  others={[false, false, false, false]}
                />

                <ComparisonSection title="Automation" />
                <ComparisonRow
                  feature="Query Scheduling"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Slack/Email Alerts"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Webhook Triggers"
                  mako={true}
                  others={[false, false, false, false]}
                />

                <ComparisonSection title="Platform" />
                <ComparisonRow
                  feature="macOS"
                  mako={true}
                  others={[true, true, true, true]}
                />
                <ComparisonRow
                  feature="Windows"
                  mako={true}
                  others={[true, true, false, true]}
                />
                <ComparisonRow
                  feature="Linux"
                  mako={true}
                  others={[true, true, false, true]}
                />
                <ComparisonRow
                  feature="Browser"
                  mako={true}
                  others={[false, false, false, false]}
                />
                <ComparisonRow
                  feature="Mobile (iPad)"
                  mako={true}
                  others={[false, false, false, false]}
                />
              </tbody>
            </table>
          </div>

          <div className="mt-8 p-6 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div>
                <h3 className="font-bold text-lg mb-1">Ready to switch?</h3>
                <p className="text-zinc-600 dark:text-zinc-400 text-sm">
                  Mako is free, open source, and takes 30 seconds to get started.
                </p>
              </div>
              <a
                href="https://app.mako.ai"
                className="px-6 py-2.5 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-500 transition-colors whitespace-nowrap"
              >
                Start Free →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features Detail */}
      <section id="features" className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">
            What makes Mako different
          </h2>

          <div className="grid md:grid-cols-2 gap-8">
            <FeatureCard
              icon="✨"
              title="AI That Actually Understands SQL"
              description="Not just autocomplete—our AI introspects your entire schema, understands relationships, and generates complex queries from natural language."
            />
            <FeatureCard
              icon="👥"
              title="Built for Teams"
              description="Share database connections securely, collaborate on queries in real-time, and maintain a version-controlled library of SQL snippets."
            />
            <FeatureCard
              icon="⚡"
              title="Instant APIs"
              description="Turn any query into a secure REST endpoint with one click. Perfect for dashboards, internal tools, and rapid prototyping."
            />
            <FeatureCard
              icon="☁️"
              title="Zero Installation"
              description="Works entirely in your browser. No downloads, no updates, no compatibility issues. Connect from anywhere."
            />
            <FeatureCard
              icon="💚"
              title="Truly Free"
              description="No trial periods, no feature gates, no credit card required. We're MIT licensed and committed to staying free."
            />
            <FeatureCard
              icon="🔒"
              title="Self-Hostable"
              description="Want full control? Deploy Mako on your own infrastructure. Your data never leaves your network."
            />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6 bg-zinc-900 dark:bg-zinc-950">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-4xl font-bold text-white mb-6">
            Make the switch today
          </h2>
          <p className="text-xl text-zinc-400 mb-10">
            Join developers who&apos;ve upgraded from legacy SQL clients.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-3.5 bg-emerald-500 text-white font-semibold rounded-lg hover:bg-emerald-400 transition-colors"
            >
              Get Started Free
            </a>
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-8 py-3.5 border border-zinc-700 text-white font-semibold rounded-lg hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              View Source
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-zinc-200 dark:border-zinc-800">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5" />
            <span className="text-zinc-500 text-sm">© 2025 Mako. MIT License.</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <a href="https://github.com/mako-ai/mono" className="hover:text-zinc-900 dark:hover:text-white transition-colors">GitHub</a>
            <a href="https://docs.mako.ai" className="hover:text-zinc-900 dark:hover:text-white transition-colors">Docs</a>
            <a href="#" className="hover:text-zinc-900 dark:hover:text-white transition-colors">Discord</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ComparisonSection({ title }: { title: string }) {
  return (
    <tr>
      <td colSpan={6} className="pt-6 pb-2 px-4 font-semibold text-xs uppercase tracking-wide text-zinc-400">
        {title}
      </td>
    </tr>
  );
}

function ComparisonRow({ feature, mako, others }: {
  feature: string;
  mako: boolean;
  others: (boolean | "partial")[];
}) {
  const Check = () => (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
      ✓
    </span>
  );
  const Cross = () => <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  const Partial = () => (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-100 dark:bg-yellow-500/20 text-yellow-600 dark:text-yellow-400">
      ~
    </span>
  );

  const getIcon = (value: boolean | "partial") => {
    if (value === true) return <Check />;
    if (value === "partial") return <Partial />;
    return <Cross />;
  };

  return (
    <tr className="border-b border-zinc-100 dark:border-zinc-800">
      <td className="py-3 px-4 text-zinc-700 dark:text-zinc-300">{feature}</td>
      <td className="text-center py-3 px-6 bg-emerald-50/50 dark:bg-emerald-500/5">
        {getIcon(mako)}
      </td>
      {others.map((o, i) => (
        <td key={i} className="text-center py-3 px-4">{getIcon(o)}</td>
      ))}
    </tr>
  );
}

function FeatureCard({ icon, title, description }: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="text-lg font-bold mb-2">{title}</h3>
      <p className="text-zinc-600 dark:text-zinc-400 text-sm leading-relaxed">{description}</p>
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
