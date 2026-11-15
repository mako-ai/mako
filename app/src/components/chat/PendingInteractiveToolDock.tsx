import { Box } from "@mui/material";
import type {
  AskClarifyingQuestionsInput,
  SubmitPlanInput,
} from "@mako/agent-tools";
import { ClarifyingQuestionsCard } from "../ClarifyingQuestionsCard";
import { PlanCard } from "../PlanCard";
import { ChatPanelErrorBoundary } from "./ChatPanelErrorBoundary";
import type { PendingInteractiveTool } from "./chat-helpers";
import type { ResolveInteractiveTool } from "./hooks/usePendingInteractiveTool";

/**
 * Pending interactive tool (clarifying questions / plan approval) — docked
 * above the composer like the prompt queue. The chat itself only shows a
 * read-only summary once the user has responded.
 */
export function PendingInteractiveToolDock({
  pending,
  chatId,
  onResolve,
}: {
  pending: PendingInteractiveTool;
  chatId: string;
  onResolve: ResolveInteractiveTool;
}) {
  const isClarify = pending.toolName === "ask_clarifying_questions";
  return (
    <ChatPanelErrorBoundary
      panel="pending question or plan"
      resetKey={pending.toolCallId}
    >
      <Box
        sx={
          isClarify ? { mx: 3.25, mt: 1, mb: -1 } : { mx: 2, mt: 1, mb: -0.5 }
        }
        key={pending.toolCallId}
      >
        {isClarify ? (
          <ClarifyingQuestionsCard
            docked
            input={pending.input as AskClarifyingQuestionsInput}
            onResolve={output =>
              onResolve({
                tool: pending.toolName,
                toolCallId: pending.toolCallId,
                output: output as unknown as Record<string, unknown>,
                viaAcpBridge: pending.viaAcpBridge,
              })
            }
          />
        ) : (
          <PlanCard
            toolCallId={pending.toolCallId}
            chatId={chatId}
            streaming={pending.streaming}
            // While streaming the input is partial — the card reads live
            // data from planStore instead (fed by setStreamingInput).
            input={
              pending.streaming ? undefined : (pending.input as SubmitPlanInput)
            }
          />
        )}
      </Box>
    </ChatPanelErrorBoundary>
  );
}
