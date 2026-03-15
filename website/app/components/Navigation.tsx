"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function Navigation() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 0);
    };

    // Check initial scroll position
    handleScroll();

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="sticky top-0 z-50 flex justify-center pt-4 px-4">
      <nav
        className={`w-full max-w-7xl border transition-all duration-300 ${
          isScrolled
            ? "shadow-md rounded-2xl border-slate-200/70 dark:border-slate-700/70 bg-white/70 dark:bg-slate-900/70 backdrop-blur-lg border-slate-200/70 dark:border-slate-700/70"
            : "border-transparent"
        }`}
      >
        <div className="px-6 py-2">
          <div className="flex items-center h-14">
            {/* Logo - Left */}
            <div className="flex items-center flex-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="28"
                height="28"
                viewBox="0 0 102 90"
                fill="none"
                className="mr-2 w-7 h-7 text-black dark:text-white"
              >
                <path
                  fill="currentColor"
                  d="m58 0 44 77-8 13H7L0 77 43 0h15ZM6 77l3 5 36-64 9 16 17 30h6L45 8 6 77Zm79-8H34l-3 5h64L55 5h-6l36 64Zm-48-5h28L51 39 37 64Z"
                />
              </svg>
              <span className="text-2xl font-[900] text-black dark:text-white">
                MAKO
              </span>
            </div>

            {/* Links - Center */}
            <div className="hidden md:flex items-center space-x-6 flex-1 justify-center">
              <Link
                href="#features"
                className="text-base text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                Features
              </Link>
              <Link
                href="#integrations"
                className="text-base text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                Integrations
              </Link>
              <Link
                href="/blog"
                className="text-base text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                Blog
              </Link>
              <Link
                href="https://docs.mako.ai"
                className="text-base text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                Documentation
              </Link>
            </div>

            {/* Login Button - Right */}
            <div className="flex items-center flex-1 justify-end">
              <a
                href="https://app.mako.ai"
                className="px-4 py-2.5 text-base rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 text-white font-medium hover:from-blue-700 hover:to-cyan-700 transition-all shadow-md hover:shadow-lg"
              >
                Launch App
              </a>
            </div>
          </div>
        </div>
      </nav>
    </div>
  );
}
