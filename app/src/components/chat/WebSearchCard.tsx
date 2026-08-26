/**
 * WebSearchCard — Beautiful UI "Thinking / Search" trace for the agent's
 * `web_search` tool, replacing the generic JSON tool card:
 *
 *   ✦ Searching the web / Searched the web   [query chip]
 *   │  ● Title                domain.com
 *   │  ● Title                domain.com
 *   │  +N more
 *
 * Sources are links (new tab). Only successful searches render this card —
 * errors fall through to the generic StreamingToolCard in ChatMessageRow.
 *
 * Anti-bounce contract: the sources rail appears exactly once, when the tool
 * reaches output-available (at the streaming tail), and its height never
 * changes afterwards except by user action (the "+N more" toggle).
 */
import React from "react";
import { Box, ButtonBase } from "@mui/material";
import { Globe, Search } from "lucide-react";
import {
  BUI_MONO_FONT_FAMILY,
  buiChipSx,
  buiShimmerLabelSx,
} from "./bui-styles";

export interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

interface WebSearchCardProps {
  /** AI SDK tool part state (input-streaming → output-available). */
  state: string;
  input?: unknown;
  output?: unknown;
}

const VISIBLE_SOURCES = 4;
const DOT_TONES = [
  "var(--bui-accent)",
  "var(--bui-orange)",
  "var(--bui-green)",
] as const;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** BUI source dot: tiny globe on a colored disc. */
function SourceDot({ tone }: { tone: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        borderRadius: "50%",
        flexShrink: 0,
        color: "#fff",
        backgroundColor: tone,
      }}
    >
      <Globe size={9} strokeWidth={2.5} />
    </Box>
  );
}

export const WebSearchCard = React.memo(function WebSearchCard({
  state,
  input,
  output,
}: WebSearchCardProps) {
  const [showAll, setShowAll] = React.useState(false);

  const query =
    typeof (input as { query?: unknown } | undefined)?.query === "string"
      ? (input as { query: string }).query
      : "";

  const out = output as
    | { success?: boolean; results?: WebSearchResultItem[] }
    | undefined;
  const done = state === "output-available" && out?.success === true;
  const results = done
    ? (out?.results ?? []).filter(
        (r): r is { title?: string; url: string; snippet?: string } =>
          typeof r?.url === "string" && r.url.length > 0,
      )
    : [];
  const visible = showAll ? results : results.slice(0, VISIBLE_SOURCES);
  const hiddenCount = results.length - visible.length;

  return (
    <Box sx={{ my: 0.5 }}>
      {/* Header — mirrors the ReasoningDisplay / tool-chip row */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          minHeight: 28,
          px: 0.75,
          mx: -0.75,
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            flexShrink: 0,
            color: "var(--bui-ink-3)",
          }}
        >
          <Search size={14} />
        </Box>
        <Box
          component="span"
          sx={{
            fontSize: "12.5px",
            fontWeight: 500,
            whiteSpace: "nowrap",
            flexShrink: 0,
            ...(done ? { color: "var(--bui-ink-2)" } : buiShimmerLabelSx),
          }}
        >
          {done ? "Searched the web" : "Searching the web"}
        </Box>
        {query && (
          <Box component="span" sx={{ ...buiChipSx, flexShrink: 1 }}>
            {query}
          </Box>
        )}
      </Box>

      {/* Sources rail — appears once, at output-available */}
      {results.length > 0 && (
        <Box
          sx={{
            ml: "7px",
            pl: 1.5,
            py: 0.25,
            borderLeft: "1px solid var(--bui-line-strong)",
            display: "flex",
            flexDirection: "column",
            gap: 0.25,
          }}
        >
          {visible.map((r, i) => (
            <Box
              key={r.url + i}
              component="a"
              href={r.url}
              target="_blank"
              rel="noreferrer"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                minHeight: 26,
                px: 0.75,
                mx: -0.75,
                borderRadius: "6px",
                textDecoration: "none",
                transition: "background-color 0.1s",
                "&:hover": { backgroundColor: "var(--bui-hover)" },
                "&:hover .web-search-title": { textDecoration: "underline" },
              }}
            >
              <SourceDot tone={DOT_TONES[i % DOT_TONES.length]} />
              <Box
                component="span"
                className="web-search-title"
                sx={{
                  fontSize: "12.5px",
                  fontWeight: 500,
                  color: "var(--bui-ink)",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.snippet}
              >
                {r.title || domainOf(r.url)}
              </Box>
              <Box
                component="span"
                sx={{
                  fontSize: "11.5px",
                  color: "var(--bui-ink-3)",
                  fontFamily: BUI_MONO_FONT_FAMILY,
                  flexShrink: 0,
                }}
              >
                {domainOf(r.url)}
              </Box>
            </Box>
          ))}
          {hiddenCount > 0 && (
            <ButtonBase
              onClick={() => setShowAll(true)}
              sx={{
                alignSelf: "flex-start",
                px: 0.75,
                mx: -0.75,
                py: 0.25,
                borderRadius: "6px",
                fontSize: "12px",
                color: "var(--bui-ink-3)",
                transition: "color 0.15s",
                "&:hover": { color: "var(--bui-ink)" },
              }}
            >
              +{hiddenCount} more
            </ButtonBase>
          )}
        </Box>
      )}
    </Box>
  );
});
WebSearchCard.displayName = "WebSearchCard";
