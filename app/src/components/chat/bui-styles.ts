// Shared Beautiful UI (beautifului.dev) style primitives for the chat.
// Colors come from the --bui-* CSS variables in index.css (light values on
// :root, dark overrides under .dark), so these style objects are stable
// module constants — theme switches restyle them without re-rendering.

export const BUI_MONO_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// Shimmering gradient-text label used for in-flight states ("Thinking",
// tool labels while generating). Matches BUI's shimmer-text treatment.
export const buiShimmerLabelSx = {
  backgroundImage:
    "linear-gradient(90deg, var(--bui-ink-3) 35%, var(--bui-ink) 50%, var(--bui-ink-3) 65%)",
  backgroundSize: "200% 100%",
  backgroundClip: "text",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  color: "transparent",
  animation: "bui-shimmer-text 1.4s linear infinite",
} as const;

// Compact mono chip (BUI "Tool Chips" secondary): field background with a
// hairline ring, truncating.
export const buiChipSx = {
  display: "inline-flex",
  alignItems: "center",
  minWidth: 0,
  height: 22,
  px: 0.75,
  borderRadius: "6px",
  backgroundColor: "var(--bui-field)",
  boxShadow: "var(--bui-shadow-hairline)",
  fontFamily: BUI_MONO_FONT_FAMILY,
  fontSize: "11.5px",
  color: "var(--bui-ink-2)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;
