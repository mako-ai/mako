import Link from "next/link";
import type { Metadata } from "next";
import DownloadButton from "../components/DownloadButton";
import { ALL_RELEASES_URL, DESKTOP_DOWNLOADS } from "../../lib/downloads";

export const metadata: Metadata = {
  title: "Download Mako Desktop",
  description:
    "Mako Desktop brings the AI-native SQL client to your machine — including connections to localhost databases via the built-in Mako Agent.",
};

export default function DownloadPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-black text-zinc-900 dark:text-white">
      {/* Gradient background */}
      <div className="fixed inset-0 pointer-events-none dark:opacity-100 opacity-30">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-zinc-400/30 rounded-full blur-[120px]" />
        <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-500/20 rounded-full blur-[120px]" />
      </div>

      <main className="relative max-w-4xl mx-auto px-6 pt-32 pb-24 text-center">
        <Link
          href="/"
          className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
        >
          ← mako.ai
        </Link>

        <h1 className="mt-8 text-4xl sm:text-5xl font-bold tracking-tight">
          Download Mako Desktop
        </h1>
        <p className="mt-6 text-lg text-zinc-600 dark:text-zinc-400 max-w-2xl mx-auto">
          The full Mako experience in a native app — with the built-in Mako
          Agent so you can query databases running on{" "}
          <code className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-white/10 text-sm">
            localhost
          </code>
          . Credentials for local connections never leave your machine.
        </p>

        <div className="mt-12">
          <DownloadButton />
        </div>

        <div className="mt-20 grid sm:grid-cols-2 gap-4 text-left">
          {DESKTOP_DOWNLOADS.map(d => (
            <a
              key={d.id}
              href={d.url}
              className="flex items-center justify-between px-6 py-5 border border-zinc-200 dark:border-white/10 rounded-xl hover:border-zinc-400 dark:hover:border-white/30 transition-colors"
            >
              <div>
                <div className="font-semibold">{d.label}</div>
                <div className="text-sm text-zinc-500 dark:text-zinc-400">
                  {d.fileType} — latest version
                </div>
              </div>
              <svg
                className="w-5 h-5 text-zinc-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4"
                />
              </svg>
            </a>
          ))}
        </div>

        <p className="mt-12 text-sm text-zinc-500 dark:text-zinc-400">
          Prefer the browser? Use{" "}
          <a
            href="https://app.mako.ai"
            className="underline hover:text-zinc-900 dark:hover:text-white"
          >
            app.mako.ai
          </a>{" "}
          — install the standalone Mako Agent for localhost connections. All
          versions and release notes are on{" "}
          <a
            href={ALL_RELEASES_URL}
            className="underline hover:text-zinc-900 dark:hover:text-white"
          >
            GitHub Releases
          </a>
          .
        </p>
      </main>
    </div>
  );
}
