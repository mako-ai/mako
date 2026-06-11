"use client";

import { useEffect, useState } from "react";
import {
  DESKTOP_DOWNLOADS,
  DesktopPlatformId,
  detectPlatform,
  getDownload,
} from "../../lib/downloads";

/**
 * Platform-aware download button: detects the visitor's OS/architecture and
 * points the primary button at the matching Mako Desktop build, with the
 * other platforms one click away.
 */
export default function DownloadButton() {
  const [platformId, setPlatformId] = useState<DesktopPlatformId>("mac-arm64");
  const [detected, setDetected] = useState(false);
  const [showOthers, setShowOthers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectPlatform().then(id => {
      if (!cancelled) {
        setPlatformId(id);
        setDetected(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const primary = getDownload(platformId);
  const others = DESKTOP_DOWNLOADS.filter(d => d.id !== platformId);

  return (
    <div className="flex flex-col items-center gap-3">
      <a
        href={primary.url}
        className="group w-full sm:w-auto px-8 py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-semibold rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors flex items-center justify-center gap-2"
      >
        <svg
          className="w-5 h-5"
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
        <span style={{ opacity: detected ? 1 : 0.85 }}>
          Download for {primary.label}
        </span>
      </a>
      <button
        type="button"
        onClick={() => setShowOthers(v => !v)}
        className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
      >
        Other platforms {showOthers ? "▴" : "▾"}
      </button>
      {showOthers && (
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm">
          {others.map(d => (
            <a
              key={d.id}
              href={d.url}
              className="px-4 py-2 border border-zinc-300 dark:border-white/15 rounded-lg text-zinc-700 dark:text-zinc-300 hover:border-zinc-500 dark:hover:border-white/40 transition-colors"
            >
              {d.label}{" "}
              <span className="text-zinc-400 dark:text-zinc-500">
                {d.fileType}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
