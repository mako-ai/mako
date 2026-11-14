import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useTheme } from "@mui/material";

/**
 * Renders kernel `text/html` output (pandas tables, styled reprs) inside a
 * sandboxed iframe instead of `dangerouslySetInnerHTML`.
 *
 * Notebook outputs are stored in git and shown to every workspace member, so
 * this HTML is untrusted: `<img onerror>`, `javascript:` links and the like
 * would run in the app origin with the viewer's session. The sandbox omits
 * `allow-scripts`, so nothing in the frame can execute (inline handlers
 * included), and the CSP below stops it from loading remote resources
 * (no tracking pixels / exfiltration via CSS). `allow-same-origin` is kept
 * only so the parent can measure the content height; without scripts it
 * grants the frame nothing.
 */
const FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

export function KernelHtmlFrame({ html }: { html: string }) {
  const theme = useTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const srcDoc = useMemo(() => {
    const css = `
      :root { color-scheme: ${theme.palette.mode}; }
      html, body { margin: 0; padding: 0; background: transparent; }
      body {
        color: ${theme.palette.text.primary};
        font-family: ${theme.typography.fontFamily ?? "sans-serif"};
        font-size: 0.78rem;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 4px 8px;
      }
      table { border-collapse: collapse; font-size: 0.78rem; }
      td, th { border: 1px solid ${theme.palette.divider}; padding: 0 4px; }
      img, svg { max-width: 100%; }
    `;
    return (
      "<!doctype html><html><head>" +
      '<meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
      `<style>${css}</style></head><body>${html}</body></html>`
    );
  }, [html, theme]);

  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    setHeight(doc.documentElement.scrollHeight);
  }, []);

  const handleLoad = useCallback(() => {
    observerRef.current?.disconnect();
    measure();
    const body = frameRef.current?.contentDocument?.body;
    if (body && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(body);
      observerRef.current = observer;
    }
  }, [measure]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return (
    <Box
      component="iframe"
      ref={frameRef}
      title="Kernel HTML output"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={handleLoad}
      sx={{
        display: "block",
        width: "100%",
        height: height || 24,
        border: 0,
        colorScheme: theme.palette.mode,
      }}
    />
  );
}
