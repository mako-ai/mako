"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

// V3: Terminal Aesthetic - Developer-focused with CLI vibes
export default function V3TerminalAesthetic() {
  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9] font-mono">
      {/* Navigation */}
      <nav className="border-b border-[#30363d]">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2 text-white font-bold">
              <span className="text-emerald-400">$</span> mako
            </Link>
            <div className="hidden md:flex items-center gap-4 text-sm text-[#8b949e]">
              <Link href="#features" className="hover:text-white transition-colors">--features</Link>
              <Link href="https://docs.mako.ai" className="hover:text-white transition-colors">--docs</Link>
              <Link href="https://github.com/mako-ai/mono" className="hover:text-white transition-colors">--source</Link>
            </div>
          </div>
          <a
            href="https://app.mako.ai"
            className="px-4 py-1.5 text-sm border border-emerald-500 text-emerald-400 rounded hover:bg-emerald-500/10 transition-colors"
          >
            launch →
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="py-20 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Terminal Window */}
          <div className="rounded-lg border border-[#30363d] bg-[#161b22] overflow-hidden shadow-2xl">
            {/* Terminal Header */}
            <div className="flex items-center gap-2 px-4 py-2 bg-[#21262d] border-b border-[#30363d]">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
                <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
                <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
              </div>
              <span className="flex-1 text-center text-xs text-[#8b949e]">mako — zsh — 80x24</span>
            </div>

            {/* Terminal Content */}
            <div className="p-6 text-sm leading-relaxed">
              <TerminalTyping />
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-6 mt-12 text-center">
            <div>
              <div className="text-3xl font-bold text-white">100%</div>
              <div className="text-sm text-[#8b949e]">Open Source</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-white">0</div>
              <div className="text-sm text-[#8b949e]">Installation Required</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-white">∞</div>
              <div className="text-sm text-[#8b949e]">AI Queries</div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-6 border-t border-[#30363d]">
        <div className="max-w-4xl mx-auto">
          <div className="mb-12">
            <span className="text-emerald-400">## </span>
            <span className="text-white text-2xl font-bold">Features</span>
          </div>

          <div className="space-y-6">
            <FeatureBlock
              flag="--ai"
              title="AI-Powered Query Generation"
              description="Describe what you want in plain English. Mako's AI understands your schema and generates optimized SQL."
              code="mako query --ai 'find users who churned last month'"
            />
            <FeatureBlock
              flag="--collab"
              title="Team Collaboration"
              description="Share database connections, version-control your queries, and work together in real-time."
              code="mako share ./queries --team engineering"
            />
            <FeatureBlock
              flag="--api"
              title="Instant API Endpoints"
              description="Turn any query into a REST API with a single command. Perfect for dashboards and tools."
              code="mako publish ./revenue-report.sql --endpoint /api/revenue"
            />
            <FeatureBlock
              flag="--cloud"
              title="Zero Installation"
              description="Runs entirely in your browser. No downloads, no dependencies, no config files."
              code="# just open app.mako.ai — that's it"
            />
            <FeatureBlock
              flag="--oss"
              title="Fully Open Source"
              description="MIT licensed. Self-host it, fork it, contribute to it. Your data, your rules."
              code="git clone https://github.com/mako-ai/mono && pnpm dev"
            />
            <FeatureBlock
              flag="--fast"
              title="Blazing Fast Performance"
              description="No Java, no Electron bloat. Opens instantly. Because waiting for software to load is so 2010."
              code="time mako open  # 0.2s — try that with DataGrip"
            />
            <FeatureBlock
              flag="--history"
              title="Query History Sync"
              description="Every query saved and synced across all your devices. Full-text search. Never lose work."
              code="mako history search 'revenue' --since '30 days ago'"
            />
            <FeatureBlock
              flag="--ssh"
              title="One-Click SSH Tunnels"
              description="Connect to databases behind firewalls without terminal wizardry. Just works."
              code="mako tunnel --via bastion.example.com --to db.internal:5432"
            />
            <FeatureBlock
              flag="--schedule"
              title="Scheduled Queries"
              description="Run queries on a schedule. Get results via Slack, email, or webhook."
              code="mako schedule ./daily-report.sql --cron '0 9 * * *' --slack #reports"
            />
            <FeatureBlock
              flag="--security"
              title="Enterprise Security"
              description="Encrypted credentials, audit logs, data masking for PII, role-based access."
              code="mako config --encrypt-credentials --audit-log --mask-pii"
            />
            <FeatureBlock
              flag="--explain"
              title="Visual EXPLAIN Plans"
              description="See how your queries execute. Find bottlenecks. Optimize like a pro."
              code="mako explain ./slow-query.sql --visual"
            />
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="py-20 px-6 border-t border-[#30363d]">
        <div className="max-w-4xl mx-auto">
          <div className="mb-12">
            <span className="text-emerald-400">## </span>
            <span className="text-white text-2xl font-bold">vs The Competition</span>
          </div>

          <div className="rounded-lg border border-[#30363d] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#21262d]">
                <tr>
                  <th className="text-left py-3 px-4 text-[#8b949e] font-normal">Feature</th>
                  <th className="text-center py-3 px-4 text-emerald-400">mako</th>
                  <th className="text-center py-3 px-4 text-[#8b949e]">datagrip</th>
                  <th className="text-center py-3 px-4 text-[#8b949e]">dbeaver</th>
                  <th className="text-center py-3 px-4 text-[#8b949e]">postico</th>
                </tr>
              </thead>
              <tbody>
                <CompareRow feature="AI queries" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="Web-based" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="Collaboration" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="One-click APIs" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="Free" mako="✓" others={["✗", "~", "✗"]} />
                <CompareRow feature="Open source" mako="✓" others={["✗", "~", "✗"]} />
                <CompareRow feature="Cross-platform" mako="✓" others={["✓", "✓", "✗"]} />
                <CompareRow feature="Instant startup" mako="✓" others={["✗", "✗", "✓"]} />
                <CompareRow feature="Query history sync" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="SSH tunneling" mako="✓" others={["✓", "✓", "✓"]} />
                <CompareRow feature="Query scheduling" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="Data masking" mako="✓" others={["✗", "✗", "✗"]} />
                <CompareRow feature="Audit logs" mako="✓" others={["✗", "✗", "✗"]} />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6 border-t border-[#30363d]">
        <div className="max-w-2xl mx-auto text-center">
          <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-8">
            <div className="text-lg mb-4">
              <span className="text-emerald-400">$</span> Ready to upgrade your database workflow?
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href="https://app.mako.ai"
                className="w-full sm:w-auto px-6 py-2 bg-emerald-500 text-black font-medium rounded hover:bg-emerald-400 transition-colors"
              >
                mako --start
              </a>
              <a
                href="https://github.com/mako-ai/mono"
                className="w-full sm:w-auto px-6 py-2 border border-[#30363d] text-[#c9d1d9] rounded hover:bg-[#21262d] transition-colors"
              >
                git clone mako
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 border-t border-[#30363d]">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[#8b949e]">
          <div>© 2025 mako • MIT License</div>
          <div className="flex items-center gap-6">
            <a href="https://github.com/mako-ai/mono" className="hover:text-white transition-colors">GitHub</a>
            <a href="https://docs.mako.ai" className="hover:text-white transition-colors">Docs</a>
            <a href="#" className="hover:text-white transition-colors">Discord</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function TerminalTyping() {
  const [line, setLine] = useState(0);
  const lines = [
    { type: "prompt", text: "$ mako connect postgres://prod.db.example.com" },
    { type: "output", text: "✓ Connected to production-db (PostgreSQL 15.2)" },
    { type: "prompt", text: "$ mako query --ai \"show me revenue by month for 2024\"" },
    { type: "output", text: "⠋ Analyzing schema... found 47 tables" },
    { type: "output", text: "✓ Generated SQL query" },
    { type: "code", text: "SELECT DATE_TRUNC('month', created_at) AS month," },
    { type: "code", text: "       SUM(amount) AS revenue" },
    { type: "code", text: "FROM orders" },
    { type: "code", text: "WHERE created_at >= '2024-01-01'" },
    { type: "code", text: "GROUP BY 1 ORDER BY 1;" },
    { type: "output", text: "✓ 12 rows returned in 45ms" },
    { type: "prompt", text: "$ mako publish --endpoint /api/revenue" },
    { type: "output", text: "✓ API endpoint live at https://app.mako.ai/api/revenue" },
    { type: "prompt", text: "$ _" },
  ];

  useEffect(() => {
    const timer = setInterval(() => {
      setLine((l) => (l < lines.length - 1 ? l + 1 : 0));
    }, 800);
    return () => clearInterval(timer);
  }, [lines.length]);

  return (
    <div className="space-y-1">
      {lines.slice(0, line + 1).map((l, i) => (
        <div key={i} className={
          l.type === "prompt" ? "text-white" :
          l.type === "code" ? "text-emerald-400 pl-4" :
          "text-[#8b949e]"
        }>
          {l.text}
          {i === line && l.type === "prompt" && l.text.endsWith("_") && (
            <span className="animate-pulse">▊</span>
          )}
        </div>
      ))}
    </div>
  );
}

function FeatureBlock({ flag, title, description, code }: {
  flag: string;
  title: string;
  description: string;
  code: string;
}) {
  return (
    <div className="p-6 rounded-lg border border-[#30363d] bg-[#161b22]">
      <div className="flex items-center gap-3 mb-3">
        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-xs">{flag}</span>
        <h3 className="text-white font-bold">{title}</h3>
      </div>
      <p className="text-[#8b949e] text-sm mb-4">{description}</p>
      <div className="p-3 rounded bg-[#0d1117] text-sm">
        <span className="text-[#8b949e]">$</span> <span className="text-emerald-400">{code}</span>
      </div>
    </div>
  );
}

function CompareRow({ feature, mako, others }: {
  feature: string;
  mako: string;
  others: string[];
}) {
  return (
    <tr className="border-t border-[#30363d]">
      <td className="py-3 px-4">{feature}</td>
      <td className="text-center py-3 px-4 text-emerald-400 bg-emerald-500/5">{mako}</td>
      {others.map((o, i) => (
        <td key={i} className={`text-center py-3 px-4 ${o === "✗" ? "text-red-400" : o === "~" ? "text-yellow-400" : "text-emerald-400"}`}>
          {o}
        </td>
      ))}
    </tr>
  );
}
