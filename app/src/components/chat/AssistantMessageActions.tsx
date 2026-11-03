/**
 * Actions on a settled assistant turn.
 *
 * Until now the only way to get text out of a reply was Streamdown's
 * per-code-block copy, or the header's raw JSON dump of the entire chat. This
 * copies the turn's prose as markdown.
 *
 * Memoized per the ChatMessageRow child rule (chat-performance): its only prop
 * is a string, so the memo is trivially correct.
 */

import React from "react";
import { MessageFooter } from "../ui/message";
import { Button } from "../ui/button";
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
      <MessageFooter className="assistant-message-actions mt-2 px-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCopy}
          aria-label={title}
          title={title}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        <span role="status" className="sr-only">
          {failed ? "Copy failed" : copied ? "Copied" : ""}
        </span>
      </MessageFooter>
    );
  },
);
