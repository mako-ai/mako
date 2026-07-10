import { Box } from "@mui/material";

import type { KernelOutput } from "../notebook-runtime/kernel";

/** Strip ANSI escape codes (kernel tracebacks are colourised). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;
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

/** Render one mime bundle, picking the richest representation we support. */
function MimeBundle({ data }: { data: Record<string, unknown> }) {
  const png = data["image/png"];
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
  const html = data["text/html"];
  if (typeof html === "string") {
    // Output produced by the user's own kernel in their workspace. Rendering
    // rich HTML (pandas tables, plots) is the point; sanitize before notebooks
    // become cross-user durable (Git-storage slice).
    return (
      <Box
        sx={{
          px: 1,
          py: 0.5,
          overflowX: "auto",
          "& table": { borderCollapse: "collapse", fontSize: "0.78rem" },
          "& td, & th": { border: 1, borderColor: "divider", px: 0.5 },
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  const plain = data["text/plain"];
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
}: {
  outputs: KernelOutput[];
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
          return <MimeBundle key={i} data={o.data} />;
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
