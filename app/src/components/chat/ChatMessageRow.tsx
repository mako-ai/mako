import React, { useState } from "react";
import { Box, List, ListItem, Paper, Tooltip } from "@mui/material";
import { StreamingMarkdown } from "../StreamingMarkdown";
import { StreamingToolCard, type ToolPartState } from "../StreamingToolCard";
import { ClarifyingQuestionsCard } from "../ClarifyingQuestionsCard";
import { DbtRunCard } from "../DbtRunCard";
import { PlanCard } from "../PlanCard";
import { McpApprovalCard } from "../McpApprovalCard";
import type {
  AskClarifyingQuestionsInput,
  AskClarifyingQuestionsOutput,
  SubmitPlanInput,
  SubmitPlanOutput,
} from "@mako/agent-tools";
import {
  computeReasoningGroups,
  getStreamingReasoningGroupStart,
} from "../reasoning-groups";
import {
  chatMessageRowArePropsEqual,
  type ChatMessageRowProps,
} from "../chat-message-comparator";
import { useRenderCount, useWhyChanged } from "../../utils/renderDebug";
import {
  getConsoleToolPresentation,
  type ToolInvocationInfo,
} from "./tool-presentation";
import { ReasoningDisplay } from "./ReasoningDisplay";
import { StreamingIndicator } from "./StreamingIndicator";
import {
  formatCostUsd,
  formatTokenCount,
  getResponseCostMetadata,
  type ResponseCostMetadata,
} from "./response-cost";
import { BUI_MONO_FONT_FAMILY } from "./bui-styles";
import { CollapsibleUserText } from "./CollapsibleUserText";
import { WebSearchCard } from "./WebSearchCard";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import { isRawMcpToolLabel } from "../../lib/local-acp-parts";

// ── Memoized message row ─────────────────────────────────────────
// Prevents completed messages from re-rendering on every streaming chunk.

// User message — Beautiful UI chat style: right-aligned rounded bubble.
const userMessageSx = {
  flex: 1,
  mt: 2,
  minWidth: 0,
  display: "flex",
  justifyContent: "flex-end",
} as const;
const userMessagePaperSx = {
  p: 1,
  px: 1.5,
  border: "none",
  borderRadius: "14px",
  backgroundColor: "var(--bui-inset)",
  boxShadow: "var(--bui-shadow-hairline)",
  overflow: "hidden",
  width: "fit-content",
  maxWidth: "88%",
} as const;
const assistantMessageSx = {
  flex: 1,
  // The row must clip runaway-wide content (tables, code) — but a plain
  // overflow:hidden box also clips the BUI card shadows (1px ring + 6px
  // blur) of full-width children at its left/right edges. Same clip-box
  // trick as Beautiful UI: pad the box 8px so shadows have room inside the
  // clip, and pull it back with matching negative margins so alignment is
  // unchanged (top: the 8px padding replaces the old mt: 1).
  overflow: "hidden",
  p: "8px",
  mx: "-8px",
  mt: 0,
  mb: "-8px",
  fontSize: "0.875rem",
  "& pre": { margin: 0, overflow: "hidden" },
} as const;
const listItemSx = { p: 0 } as const;

// Quiet per-response cost tag at the end of a finished assistant turn.
// Memoized per the ChatMessageRow child rule (chat-performance).
const ResponseCostTag = React.memo(function ResponseCostTag({
  meta,
}: {
  meta: ResponseCostMetadata;
}) {
  const tooltip = [
    meta.modelId,
    meta.inputTokens != null && `${formatTokenCount(meta.inputTokens)} in`,
    meta.outputTokens != null && `${formatTokenCount(meta.outputTokens)} out`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip title={tooltip} placement="left">
      <Box
        component="span"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          width: "fit-content",
          mt: 0.75,
          fontFamily: BUI_MONO_FONT_FAMILY,
          fontSize: "11px",
          color: "var(--bui-ink-3)",
          fontVariantNumeric: "tabular-nums",
          cursor: "default",
          transition: "color 0.15s",
          "&:hover": { color: "var(--bui-ink-2)" },
          animation: "bui-fade-in 300ms ease-out both",
        }}
      >
        {formatCostUsd(meta.costUsd ?? 0)}
      </Box>
    </Tooltip>
  );
});

export const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  isLastMessage,
  isStreaming,
  collapseEmptyReasoningWhileStreaming = false,
  onToolClick,
  onConsoleTitleClick,
  onMcpApprovalResponse,
  connectionIconById,
  paletteMode,
}: ChatMessageRowProps) {
  const parts = (message.parts || []) as Array<Record<string, unknown>>;
  useRenderCount(`ChatMessageRow:${message.id}`, {
    role: message.role,
    partCount: parts.length,
  });
  useWhyChanged(`ChatMessageRow:${message.id}`, {
    messageRef: message,
    partsRef: message.parts,
    partCount: parts.length,
    isLastMessage,
    isStreaming,
    onToolClick,
    onConsoleTitleClick,
    connectionIconById,
    paletteMode,
  });

  // Lightbox state for clicking an attached image to preview it full-size.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (message.role === "user") {
    const fileParts = (message.parts || []).filter(
      (p): p is { type: "file"; url: string; mediaType: string } =>
        p.type === "file" && "url" in p,
    );
    const textContent =
      (message.parts || [])
        .filter(
          (p): p is { type: "text"; text: string } =>
            p.type === "text" && "text" in p,
        )
        .map(p => p.text)
        .join("") || "";

    return (
      <ListItem alignItems="flex-start" sx={listItemSx}>
        <Box sx={userMessageSx}>
          <Paper variant="outlined" sx={userMessagePaperSx}>
            {fileParts.length > 0 && (
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 1,
                  mb: textContent ? 1 : 0,
                }}
              >
                {fileParts.map((fp, i) => (
                  <Box
                    key={i}
                    component="img"
                    src={fp.url}
                    alt="Attached image"
                    loading="lazy"
                    decoding="async"
                    onClick={() => setPreviewSrc(fp.url)}
                    sx={{
                      width: 56,
                      height: 56,
                      borderRadius: 1.5,
                      objectFit: "cover",
                      cursor: "pointer",
                      border: 1,
                      borderColor: "divider",
                      display: "block",
                    }}
                  />
                ))}
              </Box>
            )}
            {textContent && <CollapsibleUserText text={textContent} />}
          </Paper>
        </Box>
        <ImagePreviewDialog
          src={previewSrc}
          onClose={() => setPreviewSrc(null)}
        />
      </ListItem>
    );
  }

  const isStreamingNow = isStreaming;

  const reasoningGroups = computeReasoningGroups(parts);

  // Stable identity for each reasoning block: its ordinal position among the
  // message's reasoning groups (0, 1, 2…). Keying by this instead of the raw
  // part index means an inserted `step-start`/tool/text part shifting the array
  // can't remount an existing block — a remount would reset its `finished`
  // latch and make it re-expand (flicker). Reasoning groups only ever append,
  // so ordinals are stable for the lifetime of a block.
  const reasoningGroupOrdinals = new Map<number, number>();
  {
    let ordinal = 0;
    for (const start of reasoningGroups.keys()) {
      reasoningGroupOrdinals.set(start, ordinal++);
    }
  }

  const lastPartIndex = parts.length - 1;
  const lastPart = parts.at(-1);
  const isLastPartText =
    isLastMessage && isStreamingNow && lastPart?.type === "text";

  // The single reasoning group (if any) that should stay expanded because it
  // owns the streaming last part. `null` when not streaming or the last part
  // isn't reasoning, so previously-collapsed blocks are never re-opened.
  const streamingReasoningGroupStart =
    isLastMessage && isStreamingNow
      ? getStreamingReasoningGroupStart(parts, reasoningGroups)
      : null;

  return (
    <ListItem alignItems="flex-start" sx={listItemSx}>
      <Box sx={assistantMessageSx}>
        {parts.map((part, partIndex) => {
          const partType = part.type as string;

          if (partType?.startsWith("tool-") || partType === "dynamic-tool") {
            const toolName =
              partType === "dynamic-tool"
                ? (part.toolName as string)
                : partType.split("-").slice(1).join("-");
            const rawState = part.state as string;
            const cardState: ToolPartState =
              rawState === "output-error"
                ? "error"
                : (part.state as ToolPartState);
            const cardOutput =
              rawState === "output-error"
                ? {
                    success: false,
                    error:
                      (part.errorText as string | undefined) ?? "Tool failed",
                  }
                : part.output;
            const toolCallId = (part.toolCallId as string) || "";
            const consoleToolPresentation = getConsoleToolPresentation(
              toolName,
              part.input,
              cardOutput,
              connectionIconById,
              cardState,
            );
            // Key by toolCallId when available so reordering/insertion in the
            // parts array doesn't remount completed tool cards. Falls back to
            // a type+index tag for the (rare) case where toolCallId is missing.
            const key = toolCallId
              ? `tool-${toolCallId}`
              : `tool-idx-${partIndex}`;

            // MCP tool approval flow (Claude-style allow once / always allow).
            // Approval states only occur for tools with `needsApproval` —
            // in Mako that is exclusively MCP tools.
            if (
              rawState === "approval-requested" ||
              rawState === "approval-responded" ||
              rawState === "output-denied"
            ) {
              const approval = part.approval as
                | { id?: string; approved?: boolean }
                | undefined;
              const resolution =
                rawState === "approval-requested"
                  ? "pending"
                  : rawState === "output-denied" || approval?.approved === false
                    ? "denied"
                    : "approved";
              return (
                <McpApprovalCard
                  key={key}
                  toolName={toolName}
                  input={part.input}
                  approvalId={approval?.id ?? ""}
                  resolution={resolution}
                  onRespond={onMcpApprovalResponse}
                />
              );
            }

            // Interactive plan-lifecycle tools: while pending they render in
            // the docked panel above the composer (Cursor-style), NOT in the
            // chat. Once resolved, a read-only summary appears inline here.
            // Errors fall through to the generic tool card.
            if (
              toolName === "ask_clarifying_questions" ||
              toolName === "submit_plan"
            ) {
              if (rawState === "output-available") {
                if (toolName === "ask_clarifying_questions") {
                  return (
                    <ClarifyingQuestionsCard
                      key={key}
                      input={part.input as AskClarifyingQuestionsInput}
                      output={part.output as AskClarifyingQuestionsOutput}
                    />
                  );
                }
                return (
                  <PlanCard
                    key={key}
                    toolCallId={toolCallId}
                    input={part.input as SubmitPlanInput}
                    output={part.output as SubmitPlanOutput}
                  />
                );
              }
              if (rawState !== "output-error") {
                return null;
              }
            }

            // Web search: BUI "Search" trace (query chip + source links)
            // instead of the generic JSON card. Errors and denied states fall
            // through to the generic card so failures stay visible.
            if (
              toolName === "web_search" &&
              cardState !== "error" &&
              !(
                cardState === "output-available" &&
                (cardOutput as { success?: boolean } | undefined)?.success ===
                  false
              )
            ) {
              return (
                <WebSearchCard
                  key={key}
                  state={cardState}
                  input={part.input}
                  output={cardOutput}
                />
              );
            }

            // Async dbt builds: once dbt_run_model has dispatched a run (output
            // carries a runId), render a live run card that self-polls the run
            // — decoupled from the agent turn, so it keeps updating after the
            // turn ends and resumes on chat reload. While the dispatch is still
            // in flight, or if it errored without a runId, fall through to the
            // generic card.
            if (
              toolName === "dbt_run_model" &&
              rawState === "output-available"
            ) {
              const dbtOutput = cardOutput as { runId?: string } | undefined;
              const dbtInput = part.input as
                | { projectId?: string; model?: string }
                | undefined;
              if (dbtOutput?.runId && dbtInput?.projectId) {
                return (
                  <DbtRunCard
                    key={key}
                    runId={dbtOutput.runId}
                    projectId={dbtInput.projectId}
                    label={dbtInput.model}
                  />
                );
              }
            }
            return (
              <StreamingToolCard
                key={key}
                toolCallId={toolCallId}
                toolName={toolName}
                state={cardState}
                input={part.input}
                output={cardOutput}
                labelOverride={
                  consoleToolPresentation?.title ||
                  (typeof part.title === "string" &&
                  part.title.trim() &&
                  !isRawMcpToolLabel(part.title) &&
                  // Don't override native labels with the raw tool id
                  // (e.g. ACP "ToolSearch" === toolName).
                  part.title.trim() !== toolName
                    ? part.title
                    : undefined)
                }
                leadingIconUrl={consoleToolPresentation?.iconUrl}
                leadingIconAlt={
                  consoleToolPresentation ? "Database" : undefined
                }
                bodyPreview={
                  consoleToolPresentation?.diff
                    ? {
                        content: consoleToolPresentation.diff,
                        language: "diff",
                      }
                    : undefined
                }
                onTitleClick={
                  consoleToolPresentation
                    ? () =>
                        onConsoleTitleClick(consoleToolPresentation.consoleId)
                    : undefined
                }
                onDetailClick={() =>
                  onToolClick({
                    toolCallId,
                    toolName: toolName || "",
                    state: part.state as ToolInvocationInfo["state"],
                    input: part.input,
                    output: cardOutput,
                  })
                }
              />
            );
          }

          if (partType === "reasoning") {
            const group = reasoningGroups.get(partIndex);
            if (!group) return null;
            const isGroupStreaming = partIndex === streamingReasoningGroupStart;
            // Skip empty reasoning groups unless they're the block currently
            // streaming (a brand-new thinking block whose text hasn't arrived
            // yet). This avoids rendering blank "Thinking process" blocks for
            // empty reasoning parts loaded from history.
            if (!group.text && !isGroupStreaming) return null;
            return (
              <ReasoningDisplay
                key={`reasoning-group-${reasoningGroupOrdinals.get(partIndex) ?? partIndex}`}
                reasoningText={group.text}
                isStreaming={isGroupStreaming}
                collapseEmptyWhileStreaming={
                  collapseEmptyReasoningWhileStreaming
                }
                paletteMode={paletteMode}
              />
            );
          }

          if (partType === "text" && (part as { text?: string }).text) {
            // Only the trailing text block of the actively streaming
            // message is still growing — flag it so Streamdown knows to
            // treat its last markdown block as incomplete. All earlier
            // text blocks are static and can skip animation entirely.
            const isTrailingStreamingText =
              isLastPartText && partIndex === lastPartIndex;
            return (
              <StreamingMarkdown
                key={`text-${partIndex}`}
                isStreaming={isTrailingStreamingText}
              >
                {(part as { text: string }).text}
              </StreamingMarkdown>
            );
          }

          return null;
        })}
        {isStreaming && isLastMessage && <StreamingIndicator />}
        {(() => {
          // Cost tag only once the turn is settled — never under the loader.
          if (isStreaming && isLastMessage) return null;
          const costMeta = getResponseCostMetadata(message);
          return costMeta ? <ResponseCostTag meta={costMeta} /> : null;
        })()}
      </Box>
    </ListItem>
  );
}, chatMessageRowArePropsEqual);

ChatMessageRow.displayName = "ChatMessageRow";

// List element Virtuoso renders the (windowed) message rows into. Rendered as
// a MUI `<List dense component="div">` so the `dense` ListContext still reaches
// each `ChatMessageRow`'s `<ListItem>` (context flows through Virtuoso's div
// Item wrappers regardless of DOM nesting) while avoiding `<ul>` DOM-nesting
// warnings. Virtuoso owns the inline `style` (it sets paddingTop/Bottom to
// offset windowed items) so we must forward it onto the list element.
export const MessageVirtuosoList = React.memo(
  React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function MessageVirtuosoList({ style, children }, ref) {
      return (
        <List dense component="div" ref={ref} style={style} sx={{ px: 2 }}>
          {children}
        </List>
      );
    },
  ),
);
MessageVirtuosoList.displayName = "MessageVirtuosoList";
