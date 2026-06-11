import { useConsoleStore } from "../store/consoleStore";
import {
  CONSOLE_EXECUTOR_TOOL_NAMES,
  type AgentToolName,
} from "./client-tool-manifest";

type ChartSpecChangePayload =
  import("../components/Editor").ChartSpecChangePayload;

interface ToolCallPayload {
  toolName: string;
  toolCallId: string;
}

interface ActiveToolRegistration {
  abortController: AbortController;
  executionId: string;
}

interface ExecuteConsoleAgentToolOptions {
  toolCall: ToolCallPayload;
  input: Record<string, unknown>;
  workspaceId?: string;
  onChartSpecChange?: (payload: ChartSpecChangePayload) => void;
  addToolOutput: (payload: {
    tool: string;
    toolCallId: string;
    output: Record<string, unknown>;
  }) => void;
  registerActiveClientToolCall: (
    toolName: string,
    toolCallId: string,
    options?: {
      executionId?: string;
      cancel?: () => void | Promise<void>;
      cancellationOutput?: Record<string, unknown>;
    },
  ) => ActiveToolRegistration;
  settleActiveClientToolCall: (
    toolName: string,
    toolCallId: string,
    output: Record<string, unknown>,
  ) => void | Promise<void>;
}

function emitToolOutput(
  addToolOutput: ExecuteConsoleAgentToolOptions["addToolOutput"],
  toolName: string,
  toolCallId: string,
  output: Record<string, unknown>,
) {
  addToolOutput({ tool: toolName, toolCallId, output });
}

function isConsoleOrChartClientTool(toolName: string): boolean {
  return CONSOLE_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName);
}

/**
 * Client-side console-executor tools.
 *
 * Since issue #475 the console DATA tools (read/modify/create/
 * set_connection/run/open) execute server-side against the authoritative
 * draft — open windows follow along via the realtime channel
 * (realtimeStore). What remains in the browser:
 *   - list_open_consoles: which tabs are open is a browser question
 *   - modify_chart_spec: renders into the active results panel
 */
export async function executeConsoleAgentTool({
  toolCall,
  input,
  onChartSpecChange,
  addToolOutput,
  registerActiveClientToolCall,
  settleActiveClientToolCall,
}: ExecuteConsoleAgentToolOptions): Promise<boolean> {
  const { toolName, toolCallId } = toolCall;

  if (!isConsoleOrChartClientTool(toolName)) {
    return false;
  }

  if (toolName === "list_open_consoles") {
    const currentStore = useConsoleStore.getState();
    const currentTabs = Object.values(currentStore.tabs);
    const currentActiveId = currentStore.activeTabId;

    const consoles = currentTabs
      .filter((tab: any) => tab?.kind === undefined || tab?.kind === "console")
      .map((tab: any) => ({
        id: tab.id,
        title: tab.title || "Untitled",
        connectionId: tab.connectionId,
        connectionName: tab.metadata?.connectionName || tab.connectionId,
        databaseName:
          tab.databaseName || tab.metadata?.queryOptions?.databaseName,
        contentPreview:
          (tab.content || "").slice(0, 100) +
          ((tab.content || "").length > 100 ? "..." : ""),
        isActive: tab.id === currentActiveId,
      }));

    emitToolOutput(addToolOutput, toolName, toolCallId, {
      success: true,
      consoles,
      message: `Found ${consoles.length} open console(s)`,
    });
    return true;
  }

  if (toolName === "modify_chart_spec") {
    const vegaLiteSpec = input.vegaLiteSpec as
      | Record<string, unknown>
      | undefined;
    if (!vegaLiteSpec) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "vegaLiteSpec is required.",
      });
      return true;
    }

    const { MakoChartSpec: MakoChartSpecSchema } = await import(
      "../lib/chart-spec"
    );
    const parsed = MakoChartSpecSchema.safeParse(vegaLiteSpec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue: any) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: `Invalid Vega-Lite spec: ${issues}. Fix the spec and try again.`,
      });
      return true;
    }

    if (!onChartSpecChange) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "No active console tab to display the chart in.",
      });
      return true;
    }

    const { abortController } = registerActiveClientToolCall(
      toolName,
      toolCallId,
    );

    void (async () => {
      try {
        const renderResult = await new Promise<{
          success: boolean;
          error?: string;
        }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            abortController.signal.removeEventListener("abort", handleAbort);
            resolve({ success: true });
          }, 5000);

          const handleAbort = () => {
            clearTimeout(timeout);
            abortController.signal.removeEventListener("abort", handleAbort);
            reject(new DOMException("Chart update cancelled", "AbortError"));
          };

          if (abortController.signal.aborted) {
            handleAbort();
            return;
          }

          abortController.signal.addEventListener("abort", handleAbort, {
            once: true,
          });

          onChartSpecChange({
            spec: parsed.data,
            onRenderResult: result => {
              clearTimeout(timeout);
              abortController.signal.removeEventListener("abort", handleAbort);
              resolve(result);
            },
          });
        });

        if (renderResult.success) {
          settleActiveClientToolCall(toolName, toolCallId, {
            success: true,
            message: "Chart rendered successfully in the results panel.",
          });
        } else {
          settleActiveClientToolCall(toolName, toolCallId, {
            success: false,
            error: `Chart failed to render: ${renderResult.error}. Fix the Vega-Lite spec and try again.`,
          });
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        settleActiveClientToolCall(toolName, toolCallId, {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Chart rendering failed unexpectedly.",
        });
      }
    })();
    return true;
  }

  return false;
}
