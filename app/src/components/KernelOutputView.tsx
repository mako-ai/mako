import { useEffect, useState } from "react";
import { Box } from "@mui/material";

import type {
  KernelArtifactRef,
  KernelOutput,
} from "../notebook-runtime/kernel";
import { getApiBasePath } from "../lib/api-base-path";

/** Strip ANSI escape codes (kernel tracebacks are colourised). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const PRE_SX = {
  m: 0,
  px: 1,
  py: 0.5,
  fontFamily: "monospace",
  fontSize: "0.78rem",
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-word" as const,
  overflowX: "auto" as const,
};

/** URL of an offloaded output artifact (same-origin; the session cookie auths
 * the request, so `<img src>` and `fetch` both work). */
function artifactUrl(
  workspaceId: string,
  notebookId: string,
  ref: KernelArtifactRef,
): string {
  const base = getApiBasePath(import.meta.env.VITE_API_URL);
  return `${base}/workspaces/${workspaceId}/notebooks/${notebookId}/artifacts/${ref.artifactId}`;
}

const HTML_SX = {
  px: 1,
  py: 0.5,
  overflowX: "auto" as const,
  "& table": { borderCollapse: "collapse", fontSize: "0.78rem" },
  "& td, & th": { border: 1, borderColor: "divider", px: 0.5 },
};

/** Fetch an offloaded text/HTML payload lazily and render it. */
function ArtifactText({ url, asHtml }: { url: string; asHtml: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setText(null);
    setFailed(false);
    fetch(url, { credentials: "include" })
      .then(r =>
        r.ok ? r.text() : Promise.reject(new Error(String(r.status))),
      )
      .then(t => active && setText(t))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [url]);

  if (failed) {
    return (
      <Box component="pre" sx={{ ...PRE_SX, color: "error.main" }}>
        (output unavailable)
      </Box>
    );
  }
  if (text === null) {
    return (
      <Box component="pre" sx={{ ...PRE_SX, color: "text.secondary" }}>
        Loading output…
      </Box>
    );
  }
  if (asHtml) {
    // Rich HTML from the user's own kernel (pandas tables, plots). Sanitize
    // before notebooks become cross-user durable (Git-storage slice).
    return <Box sx={HTML_SX} dangerouslySetInnerHTML={{ __html: text }} />;
  }
  return (
    <Box component="pre" sx={PRE_SX}>
      {text}
    </Box>
  );
}

interface MimeContext {
  workspaceId: string | null;
  notebookId: string;
  artifacts?: Record<string, KernelArtifactRef>;
}

/** Render one mime bundle, picking the richest representation we support.
 * A mime value may live inline in `data` or be offloaded to `artifacts`. */
function MimeBundle({
  data,
  ctx,
}: {
  data: Record<string, unknown>;
  ctx: MimeContext;
}) {
  const { workspaceId, notebookId, artifacts } = ctx;
  const refFor = (key: string): KernelArtifactRef | undefined =>
    artifacts?.[key];
  const canFetch = !!workspaceId;

  // image/png — inline base64 or an offloaded artifact URL.
  const pngRef = refFor("image/png");
  const png = data["image/png"];
  if (pngRef && workspaceId) {
    return (
      <Box sx={{ px: 1, py: 0.5 }}>
        <img
          src={artifactUrl(workspaceId, notebookId, pngRef)}
          alt="kernel output"
          style={{ maxWidth: "100%" }}
        />
      </Box>
    );
  }
  if (typeof png === "string") {
    return (
      <Box sx={{ px: 1, py: 0.5 }}>
        <img
          src={`data:image/png;base64,${png}`}
          alt="kernel output"
          style={{ maxWidth: "100%" }}
        />
      </Box>
    );
  }

  // text/html — inline or offloaded.
  const htmlRef = refFor("text/html");
  const html = data["text/html"];
  if (htmlRef && canFetch && workspaceId) {
    return (
      <ArtifactText
        url={artifactUrl(workspaceId, notebookId, htmlRef)}
        asHtml
      />
    );
  }
  if (typeof html === "string") {
    return <Box sx={HTML_SX} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  // text/plain — inline or offloaded.
  const plainRef = refFor("text/plain");
  const plain = data["text/plain"];
  if (plainRef && canFetch && workspaceId) {
    return (
      <ArtifactText
        url={artifactUrl(workspaceId, notebookId, plainRef)}
        asHtml={false}
      />
    );
  }
  if (typeof plain === "string") {
    return (
      <Box component="pre" sx={PRE_SX}>
        {plain}
      </Box>
    );
  }
  return null;
}

/** Renders the ordered outputs of a code-cell execution. */
export default function KernelOutputView({
  outputs,
  workspaceId,
  notebookId,
}: {
  outputs: KernelOutput[];
  workspaceId: string | null;
  notebookId: string;
}) {
  if (outputs.length === 0) return null;
  return (
    <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "action.hover" }}>
      {outputs.map((o, i) => {
        if (o.type === "stream") {
          return (
            <Box
              key={i}
              component="pre"
              sx={{
                ...PRE_SX,
                color: o.name === "stderr" ? "error.main" : "text.primary",
              }}
            >
              {o.text}
            </Box>
          );
        }
        if (o.type === "result" || o.type === "display") {
          return (
            <MimeBundle
              key={i}
              data={o.data}
              ctx={{ workspaceId, notebookId, artifacts: o.artifacts }}
            />
          );
        }
        // error
        return (
          <Box key={i} component="pre" sx={{ ...PRE_SX, color: "error.main" }}>
            {o.traceback.length
              ? stripAnsi(o.traceback.join("\n"))
              : `${o.ename}: ${o.evalue}`}
          </Box>
        );
      })}
    </Box>
  );
}
