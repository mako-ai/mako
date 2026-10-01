/**
 * Hover actions on a settled assistant turn.
 *
 * Until now the only way to get text out of a reply was Streamdown's
 * per-code-block copy, or the header's raw JSON dump of the entire chat. This
 * copies the turn's prose as markdown.
 *
 * Memoized per the ChatMessageRow child rule (chat-performance): its only prop
 * is a string, so the memo is trivially correct.
 */

import React from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import { Check, Copy } from "lucide-react";

export const AssistantMessageActions = React.memo(
  function AssistantMessageActions({ text }: { text: string }) {
    const [copied, setCopied] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
      if (!copied && !failed) return;
      const t = setTimeout(() => {
        setCopied(false);
        setFailed(false);
      }, 2000);
      return () => clearTimeout(t);
    }, [copied, failed]);

    if (!text.trim()) return null;

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      } catch {
        // Clipboard can be unavailable (insecure context, denied permission).
        // Say so rather than looking like a no-op.
        setFailed(true);
      }
    };

    const title = failed ? "Copy failed" : copied ? "Copied" : "Copy message";

    return (
      <Box
        className="assistant-message-actions"
        sx={{
          display: "flex",
          mt: 0.5,
          opacity: 0,
          transition: "opacity 120ms ease-out",
          ".MuiListItem-root:hover &": { opacity: 1 },
          "&:focus-within": { opacity: 1 },
        }}
      >
        <Tooltip title={title} placement="top">
          <IconButton
            size="small"
            onClick={handleCopy}
            aria-label="Copy message"
            sx={{ color: "var(--bui-ink-3)", p: 0.5 }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        </Tooltip>
      </Box>
    );
  },
);
