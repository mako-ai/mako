import Image from "next/image";
import Link from "next/link";
import Navigation from "../../components/Navigation";
import HeroAnimation from "../../components/HeroAnimation";

export default function RevOpsLandingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <Navigation />

      {/* Hero Section */}
      <section className="pt-20 pb-12 px-4 sm:px-6 lg:px-8 overflow-hidden">
        <div className="mx-auto max-w-7xl grid lg:grid-cols-2 gap-12 lg:gap-8 items-center">
          <div className="w-full flex flex-col items-start text-left z-10">
            <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-slate-900 dark:text-white mb-6 leading-tight">
              The AI Data Analyst
              <span className="block bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent">
                for Modern RevOps
              </span>
            </h1>
            <p className="text-xl md:text-2xl text-slate-600 dark:text-slate-300 mb-8 max-w-2xl leading-relaxed">
              Stop wrestling with SQL and broken spreadsheets. Unify your
              revenue stack and ask questions in plain English to get instant
              answers.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <a
                href="https://app.mako.ai"
                className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 text-white font-semibold text-lg hover:from-blue-700 hover:to-cyan-700 transition-all shadow-lg hover:shadow-blue-500/25"
              >
                Get Started Free
              </a>
              <Link
                href="#features"
                className="inline-flex items-center justify-center px-6 py-3 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-semibold text-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
              >
                Book a Demo
              </Link>
            </div>
          </div>
          <div className="relative w-full h-[500px] perspective-1000">
            <HeroAnimation />
          </div>
        </div>
      </section>

      {/* App Screenshot Section */}
      <section className="py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          <div className="relative rounded-2xl overflow-hidden shadow-2xl border border-slate-200 dark:border-slate-700">
            <Image
              src="/app-screenshot.png"
              alt="Mako App Interface"
              width={1200}
              height={800}
              className="w-full h-auto"
              priority
            />
          </div>
        </div>
      </section>
      {/* Features Section */}
      <section
        id="features"
        className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-slate-900"
      >
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              The Modern Data Stack, Simplified
            </h2>
            <p className="text-xl text-slate-600 dark:text-slate-300">
              We replaced the complex web of tools with a single, intelligent
              platform.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            <FeatureCard
              title="Zero-Config Data Pipelines"
              description="Connect Stripe, PostHog, and CRMs in seconds. We handle the schema, syncing, and maintenance so you don't have to."
              icon="🔄"
              replaces={["Airbyte", "Fivetran", "Manual Scripts"]}
            />
            <FeatureCard
              title="Conversational Intelligence"
              description="Your personal data analyst, available 24/7. Ask complex questions and get accurate charts instantly."
              icon="💬"
              replaces={["DataGrip", "Tableau", "SQL"]}
            />
            <FeatureCard
              title="Turn Insights into Action"
              description="Share live dashboards, build reports together, and align your team on the metrics that matter."
              icon="🏢"
              replaces={["Slack Screenshots", "Excel", "Emails"]}
            />
          </div>
        </div>
      </section>

      {/* Integrations Section */}
      <section id="integrations" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-bold text-slate-900 dark:text-white mb-4">
              Integrations
            </h2>
            <p className="text-xl text-slate-600 dark:text-slate-300">
              Connect your favorite tools and platforms
            </p>
          </div>
          <h3 className="text-3xl font-bold text-slate-900 dark:text-white mb-6 mt-12">
            Databases
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <IntegrationCard
              name="PostgreSQL"
              status="live"
              icon="/icons/postgresql.svg"
              description="Connect to PostgreSQL databases for powerful relational data queries"
            />
            <IntegrationCard
              name="MongoDB"
              status="live"
              icon="/icons/mongodb.svg"
              description="Connect to MongoDB for flexible document-based data"
            />
            <IntegrationCard
              name="BigQuery"
              status="live"
              icon="/icons/bigquery.svg"
              description="Analyze large datasets with Google BigQuery integration"
            />
            <IntegrationCard
              name="MySQL"
              status="coming soon"
              icon="/icons/mysql.svg"
              description="Query MySQL databases with natural language"
            />
            <IntegrationCard
              name="Snowflake"
              status="coming soon"
              icon="/icons/snowflake.svg"
              description="Query Snowflake databases with natural language"
            />
            <IntegrationCard
              name="Databricks"
              status="coming soon"
              icon="/icons/databricks.svg"
              description="Query Databricks databases with natural language"
            />
          </div>
          <h3 className="text-3xl font-bold text-slate-900 dark:text-white mb-6 mt-12">
            Connectors
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <IntegrationCard
              name="Stripe"
              status="live"
              icon="/icons/stripe.svg"
              description="Track payments, subscriptions, and customer billing data"
            />
            <IntegrationCard
              name="PostHog"
              status="live"
              icon="/icons/posthog.svg"
              description="Analyze product analytics and user behavior data"
            />
            <IntegrationCard
              name="Google Analytics"
              status="live"
              icon="/icons/google-analytics.svg"
              description="Connect website traffic and conversion data"
            />
            <IntegrationCard
              name="Google Search Console"
              icon="/icons/google-search-console.svg"
              status="live"
              description="Connect Google Search Console data"
            />
            <IntegrationCard
              name="Close.com"
              status="live"
              icon="/icons/close.svg"
              description="Sync CRM data including leads, opportunities, and activities"
            />
            <IntegrationCard
              name="GraphQL"
              status="live"
              icon="/icons/graphql.svg"
              description="Query any GraphQL API with custom endpoints"
            />
            <IntegrationCard
              name="REST"
              status="live"
              icon="/icons/rest.svg"
              description="Query any REST API with custom endpoints"
            />
            <IntegrationCard
              name="Hubspot"
              status="coming soon"
              icon="/icons/hubspot.svg"
              description="Sync CRM data including contacts, companies, deals, and activities"
            />
            <IntegrationCard
              name="Salesforce"
              status="coming soon"
              icon="/icons/salesforce.svg"
              description="Sync CRM data including accounts, contacts, opportunities, and activities"
            />
            <IntegrationCard
              name="Pipedrive"
              status="coming soon"
              icon="/icons/pipedrive.svg"
              description="Sync CRM data including deals, activities, and contacts"
            />
          </div>
          <div className="text-center mt-12">
            <p className="text-slate-600 dark:text-slate-400">
              More integrations coming soon: Hubspot, Salesforce, HubSpot, etc.
            </p>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-r from-blue-600 to-cyan-600">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-6">
            Your Data, Demystified.
          </h2>
          <p className="text-xl text-blue-100 mb-8">
            Join the teams replacing their complex data stack with Mako. Start
            analyzing in minutes.
          </p>
          <a
            href="http://localhost:5173"
            className="inline-block px-8 py-4 rounded-lg bg-white text-blue-600 font-semibold text-lg hover:bg-slate-100 transition-all shadow-lg hover:shadow-xl"
          >
            Start Analyzing Now
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-4 sm:px-6 lg:px-8 bg-slate-900 dark:bg-black">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <span className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                Mako
              </span>
              <p className="mt-4 text-slate-400">
                Data analytics platform for modern revenue operations.
              </p>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-4">Product</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="#features"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    Features
                  </Link>
                </li>
                <li>
                  <Link
                    href="#integrations"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    Integrations
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://docs.mako.ai"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    Documentation
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-4">Resources</h3>
              <ul className="space-y-2">
                <li>
                  <a
                    href="https://github.com/mako-ai/mako"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    GitHub
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    API Reference
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    Support
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-white mb-4">Company</h3>
              <ul className="space-y-2">
                <li>
                  <a
                    href="#"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    About
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    Blog
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className="text-slate-400 hover:text-white transition-colors"
                  >
                    Contact
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-slate-800 text-center text-slate-400">
            <p>&copy; 2025 Mako. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  title,
  description,
  icon,
  replaces,
}: {
  title: string;
  description: string;
  icon: string;
  replaces?: string[];
}) {
  return (
    <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:shadow-lg transition-shadow flex flex-col h-full">
      <div className="text-4xl mb-4">{icon}</div>
      <h3 className="text-xl font-semibold text-slate-900 dark:text-white mb-2">
        {title}
      </h3>
      <p className="text-slate-600 dark:text-slate-300 flex-grow">
        {description}
      </p>
      {replaces && replaces.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-2">
            Replaces:
          </p>
          <div className="flex flex-wrap gap-2">
            {replaces.map(tool => (
              <span
                key={tool}
                className="inline-block px-2 py-1 text-xs font-medium rounded-md bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationCard({
  name,
  status,
  icon,
  description,
}: {
  name: string;
  status: "live" | "coming soon";
  icon?: string;
  description?: string;
}) {
  return (
    <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:shadow-lg transition-shadow flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        {icon && (
          <Image
            src={icon}
            alt={`${name} logo`}
            width={32}
            height={32}
            className="w-8 h-8"
          />
        )}
        <span
          className={`text-xs font-medium px-2 py-1 rounded-full ${
            status === "live"
              ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
              : "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400"
          }`}
        >
          {status === "live" ? "Live" : "Coming Soon"}
        </span>
      </div>
      <h4 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
        {name}
      </h4>
      {description && (
        <p className="text-sm text-slate-600 dark:text-slate-400 flex-grow">
          {description}
        </p>
      )}
    </div>
  );
}
