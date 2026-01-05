import Link from "next/link";

// Index page showing all landing page design variants
export default function DesignsIndex() {
  const designs = [
    {
      id: "v1",
      name: "Minimal Dark",
      description: "Ultra-clean dark design inspired by Cursor and Linear. Focused on code preview and developer trust signals.",
      tags: ["Dark Mode", "Minimal", "Code-focused"],
    },
    {
      id: "v2",
      name: "Gradient Hero",
      description: "Bold gradient backgrounds with animated query demo. Inspired by Vercel and Raycast.",
      tags: ["Gradients", "Animated", "Bold"],
    },
    {
      id: "v3",
      name: "Terminal Aesthetic",
      description: "Developer-focused CLI vibes with typing animations. Appeals to power users and terminal enthusiasts.",
      tags: ["Terminal", "CLI", "Hacker"],
    },
    {
      id: "v4",
      name: "Split Screen",
      description: "Query editor on left, results on right. Shows the product in action immediately.",
      tags: ["Product-focused", "Demo", "Practical"],
    },
    {
      id: "v5",
      name: "Bento Grid",
      description: "Modern card-based layout showcasing features. Inspired by Apple and modern SaaS sites.",
      tags: ["Bento", "Cards", "Modern"],
    },
    {
      id: "v6",
      name: "Comparison Table",
      description: "Direct head-to-head comparison with DataGrip, DBeaver, Postico. Conversion-focused.",
      tags: ["Comparison", "Competitive", "Trust"],
    },
    {
      id: "v7",
      name: "Video Hero",
      description: "Large hero with video/animation showing AI in action. Visual proof of the product.",
      tags: ["Video", "Demo", "Visual"],
    },
    {
      id: "v8",
      name: "Testimonial Focus",
      description: "Social proof heavy with developer testimonials. Builds trust through peer validation.",
      tags: ["Testimonials", "Social Proof", "Trust"],
    },
    {
      id: "v9",
      name: "Interactive Demo",
      description: "Hands-on demo widget in the hero. Users can try AI queries without signing up.",
      tags: ["Interactive", "Try Before Buy", "Engagement"],
    },
    {
      id: "v10",
      name: "Animated Features",
      description: "Scroll-triggered animations and modern motion design. Premium feel with smooth transitions.",
      tags: ["Animated", "Scroll Effects", "Premium"],
    },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <header className="border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors mb-4 inline-block">
            ← Back to current site
          </Link>
          <h1 className="text-4xl font-bold mb-4">Landing Page Designs</h1>
          <p className="text-xl text-zinc-400 max-w-2xl">
            10 alternative landing page designs for Mako, repositioned as an AI-first SQL client
            competing with Postico, DBeaver, and DataGrip.
          </p>
        </div>
      </header>

      {/* Design Grid */}
      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-2 gap-6">
          {designs.map((design) => (
            <Link
              key={design.id}
              href={`/${design.id}`}
              className="group p-6 rounded-2xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 hover:border-zinc-700 transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <span className="text-xs font-mono text-zinc-500 uppercase">{design.id}</span>
                  <h2 className="text-xl font-bold group-hover:text-blue-400 transition-colors">
                    {design.name}
                  </h2>
                </div>
                <svg className="w-5 h-5 text-zinc-600 group-hover:text-white group-hover:translate-x-1 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </div>
              <p className="text-zinc-400 text-sm mb-4">{design.description}</p>
              <div className="flex flex-wrap gap-2">
                {design.tags.map((tag) => (
                  <span key={tag} className="px-2 py-1 rounded-full bg-zinc-800 text-zinc-400 text-xs">
                    {tag}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>

        {/* Key Changes Summary */}
        <section className="mt-16 p-8 rounded-2xl border border-zinc-800 bg-zinc-900/30">
          <h2 className="text-2xl font-bold mb-6">Key Messaging Changes</h2>
          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <h3 className="font-semibold text-red-400 mb-3">Removed</h3>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>• References to ETL/data pipelines</li>
                <li>• External connector integrations (Stripe, PostHog, etc.)</li>
                <li>• &quot;RevOps platform&quot; positioning</li>
                <li>• Data sync and pipeline features</li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-emerald-400 mb-3">Added</h3>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>• AI-first SQL client positioning</li>
                <li>• Comparison with Postico, DBeaver, DataGrip</li>
                <li>• Team collaboration features</li>
                <li>• One-click API generation</li>
                <li>• Free &amp; open source emphasis</li>
                <li>• Zero installation / browser-based</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Value Props */}
        <section className="mt-8 p-8 rounded-2xl border border-zinc-800 bg-zinc-900/30">
          <h2 className="text-2xl font-bold mb-6">Core Value Propositions</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <div className="text-2xl mb-2">✨</div>
              <h3 className="font-semibold mb-1">AI Query Generation</h3>
              <p className="text-sm text-zinc-400">Schema-aware AI writes optimized queries from natural language</p>
            </div>
            <div>
              <div className="text-2xl mb-2">👥</div>
              <h3 className="font-semibold mb-1">Team Collaboration</h3>
              <p className="text-sm text-zinc-400">Shared connections, version-controlled snippets, real-time editing</p>
            </div>
            <div>
              <div className="text-2xl mb-2">⚡</div>
              <h3 className="font-semibold mb-1">One-Click APIs</h3>
              <p className="text-sm text-zinc-400">Turn any query into a REST endpoint instantly</p>
            </div>
            <div>
              <div className="text-2xl mb-2">💚</div>
              <h3 className="font-semibold mb-1">Free &amp; Open Source</h3>
              <p className="text-sm text-zinc-400">MIT licensed, self-hostable, no feature gates</p>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-zinc-500">
          Preview all designs by clicking the cards above. Each design is a complete landing page.
        </div>
      </footer>
    </div>
  );
}
