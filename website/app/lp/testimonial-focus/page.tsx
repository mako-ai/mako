import Link from "next/link";
import Image from "next/image";

// V8: Testimonial Focus - Social proof heavy with developer testimonials
export default function V8TestimonialFocus() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-slate-50/80 dark:bg-slate-950/80 backdrop-blur-xl border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <MakoIcon className="w-7 h-7 text-indigo-600 dark:text-indigo-400" />
            <span className="font-bold text-xl">Mako</span>
          </Link>
          <div className="flex items-center gap-4">
            <a href="https://github.com/mako-ai/mono" className="text-sm text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors hidden sm:block">
              GitHub
            </a>
            <a
              href="https://app.mako.ai"
              className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
            >
              Get Started
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="py-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="flex items-center justify-center gap-1 mb-8">
            {[...Array(5)].map((_, i) => (
              <StarIcon key={i} className="w-6 h-6 text-yellow-400" />
            ))}
          </div>

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            Developers love
            <span className="block text-indigo-600 dark:text-indigo-400">Mako</span>
          </h1>

          <p className="text-xl text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mb-10">
            The free, open-source SQL client with AI that writes your queries,
            team collaboration, and one-click APIs. See why teams are switching.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.mako.ai"
              className="w-full sm:w-auto px-8 py-3.5 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-500 transition-colors"
            >
              Try It Free
            </a>
            <a
              href="https://github.com/mako-ai/mono"
              className="w-full sm:w-auto px-8 py-3.5 border border-slate-300 dark:border-slate-700 font-semibold rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
            >
              <GitHubIcon className="w-5 h-5" />
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Featured Testimonial */}
      <section className="py-16 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="p-8 md:p-12 rounded-3xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
            <div className="flex items-center gap-1 mb-6">
              {[...Array(5)].map((_, i) => (
                <StarIcon key={i} className="w-5 h-5 text-yellow-300" />
              ))}
            </div>
            <blockquote className="text-2xl md:text-3xl font-medium mb-8 leading-relaxed">
              &quot;We migrated our entire engineering team from DataGrip to Mako in a single day.
              The AI query generation alone saves us hours every week, and the collaboration
              features have transformed how we work with data.&quot;
            </blockquote>
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-xl font-bold">
                JD
              </div>
              <div>
                <div className="font-semibold text-lg">James Davidson</div>
                <div className="text-indigo-200">VP of Engineering at TechCorp</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Testimonial Grid */}
      <section className="py-16 px-6">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">
            What developers are saying
          </h2>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <TestimonialCard
              quote="Finally, a SQL client that doesn't feel like it's from 2005. The AI actually works and understands context."
              author="Sarah Chen"
              role="Backend Engineer"
              company="Stripe"
              rating={5}
            />
            <TestimonialCard
              quote="The one-click API feature is insane. We built 3 internal dashboards in a day using queries we already had."
              author="Marcus Johnson"
              role="Full Stack Dev"
              company="Vercel"
              rating={5}
            />
            <TestimonialCard
              quote="Being able to share database connections securely with the team has eliminated so many Slack messages."
              author="Emily Rodriguez"
              role="Data Engineer"
              company="Figma"
              rating={5}
            />
            <TestimonialCard
              quote="I was skeptical about the AI, but it genuinely understands our schema and writes better queries than I do."
              author="David Kim"
              role="Senior SWE"
              company="Shopify"
              rating={5}
            />
            <TestimonialCard
              quote="Zero installation means I can query our production database from any machine. Game changer for on-call."
              author="Lisa Thompson"
              role="SRE"
              company="Datadog"
              rating={5}
            />
            <TestimonialCard
              quote="The fact that it's open source and free is incredible. We self-host it and have full control of our data."
              author="Michael Brown"
              role="CTO"
              company="Early Stage Startup"
              rating={5}
            />
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-6 bg-white dark:bg-slate-900">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">
            Why teams switch to Mako
          </h2>
          <p className="text-center text-slate-600 dark:text-slate-400 mb-12">
            The features that make developers productive.
          </p>

          <div className="grid md:grid-cols-2 gap-8">
            <FeatureCard
              icon="✨"
              title="AI Query Generation"
              description="Describe what you want in plain English. Our AI understands your schema and writes optimized SQL."
            />
            <FeatureCard
              icon="👥"
              title="Team Collaboration"
              description="Share database connections, version-control queries, and collaborate in real-time."
            />
            <FeatureCard
              icon="⚡"
              title="One-Click APIs"
              description="Turn any query into a REST endpoint instantly. Perfect for dashboards and internal tools."
            />
            <FeatureCard
              icon="☁️"
              title="Zero Installation"
              description="Works entirely in your browser. No downloads, no config, no compatibility issues."
            />
          </div>
        </div>
      </section>

      {/* Databases */}
      <section className="py-16 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-8">Works with your favorite databases</h2>
          <div className="flex flex-wrap items-center justify-center gap-8">
            <DatabaseLogo name="PostgreSQL" icon="/icons/postgresql.svg" />
            <DatabaseLogo name="MySQL" icon="/icons/mysql.svg" />
            <DatabaseLogo name="MongoDB" icon="/icons/mongodb.svg" />
            <DatabaseLogo name="BigQuery" icon="/icons/bigquery.svg" />
            <DatabaseLogo name="Snowflake" icon="/icons/snowflake.svg" />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6 bg-slate-900 dark:bg-black">
        <div className="max-w-3xl mx-auto text-center">
          <div className="flex items-center justify-center gap-1 mb-6">
            {[...Array(5)].map((_, i) => (
              <StarIcon key={i} className="w-6 h-6 text-yellow-400" />
            ))}
          </div>
          <h2 className="text-4xl font-bold text-white mb-4">
            Join thousands of developers
          </h2>
          <p className="text-xl text-slate-400 mb-10">
            Free forever. No credit card required.
          </p>
          <a
            href="https://app.mako.ai"
            className="inline-flex items-center gap-2 px-8 py-4 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-500 transition-colors"
          >
            Get Started Free
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-slate-200 dark:border-slate-800">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <MakoIcon className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <span className="text-slate-500 text-sm">© 2025 Mako. MIT License.</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-500">
            <a href="https://github.com/mako-ai/mono" className="hover:text-slate-900 dark:hover:text-white transition-colors">GitHub</a>
            <a href="https://docs.mako.ai" className="hover:text-slate-900 dark:hover:text-white transition-colors">Docs</a>
            <a href="#" className="hover:text-slate-900 dark:hover:text-white transition-colors">Discord</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function TestimonialCard({ quote, author, role, company, rating }: {
  quote: string;
  author: string;
  role: string;
  company: string;
  rating: number;
}) {
  return (
    <div className="p-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:shadow-lg transition-shadow">
      <div className="flex items-center gap-0.5 mb-4">
        {[...Array(rating)].map((_, i) => (
          <StarIcon key={i} className="w-4 h-4 text-yellow-400" />
        ))}
      </div>
      <p className="text-slate-700 dark:text-slate-300 mb-6">&quot;{quote}&quot;</p>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-white text-sm font-bold">
          {author.split(' ').map(n => n[0]).join('')}
        </div>
        <div>
          <div className="font-medium text-sm">{author}</div>
          <div className="text-slate-500 text-xs">{role} at {company}</div>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description }: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800">
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-slate-600 dark:text-slate-400 text-sm">{description}</p>
    </div>
  );
}

function DatabaseLogo({ name, icon }: { name: string; icon: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800">
      <Image src={icon} alt={name} width={24} height={24} className="w-6 h-6" />
      <span className="text-sm font-medium text-slate-600 dark:text-slate-400">{name}</span>
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
