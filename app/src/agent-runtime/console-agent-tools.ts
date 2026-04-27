import type {
  ConsoleModification,
  ConsoleModificationPayload,
} from "../hooks/useMonacoConsole";
import type { ConsoleTab } from "../store/lib/types";
import { useConsoleStore } from "../store/consoleStore";
import { generateObjectId } from "../utils/objectId";
import {
  applyModification,
  buildModificationDiff,
} from "../utils/consoleModification";
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
  capturedConsoleId?: string | null;
  onConsoleModification?: (modification: ConsoleModificationPayload) => void;
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
  ) => void;
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

export async function executeConsoleAgentTool({
  toolCall,
  input,
  workspaceId,
  capturedConsoleId,
  onConsoleModification,
  onChartSpecChange,
  addToolOutput,
  registerActiveClientToolCall,
  settleActiveClientToolCall,
}: ExecuteConsoleAgentToolOptions): Promise<boolean> {
  const { toolName, toolCallId } = toolCall;

  if (!isConsoleOrChartClientTool(toolName)) {
    return false;
  }

  if (toolName === "read_console") {
    const consoleId = input.consoleId as string | undefined;

    if (!consoleId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "consoleId is required. Use list_open_consoles first to get available console IDs.",
      });
      return true;
    }

    const currentStore = useConsoleStore.getState();
    const currentTabs = Object.values(currentStore.tabs);
    const targetConsole = currentTabs.find((consoleTab: any) => {
      return consoleTab.id === consoleId;
    });

    if (!targetConsole) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
      });
      return true;
    }

    const rawContent = targetConsole.content || "";
    const lines = rawContent.split("\n");
    const totalLines = lines.length;
    const lineNumberWidth = String(totalLines).length;
    const content = lines
      .map(
        (line: string, index: number) =>
          `${String(index + 1).padStart(lineNumberWidth)}| ${line}`,
      )
      .join("\n");

    emitToolOutput(addToolOutput, toolName, toolCallId, {
      success: true,
      consoleId: targetConsole.id,
      title: targetConsole.title,
      content,
      totalLines,
      connectionId: targetConsole.connectionId,
      connectionType: (targetConsole.metadata as { connectionType?: string })
        ?.connectionType,
      databaseId: targetConsole.databaseId,
      databaseName: targetConsole.databaseName,
    });
    return true;
  }

  if (toolName === "modify_console") {
    const action = input.action as "replace" | "insert" | "append" | "patch";
    const content = input.content as string;
    const position = input.position as number | null;
    const consoleId = input.consoleId as string | undefined;
    const modifyTitle = input.title as string | undefined;
    const startLine = input.startLine as number | undefined;
    const endLine = input.endLine as number | undefined;

    if (!consoleId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "consoleId is required. Use list_open_consoles to get IDs of existing consoles, or create_console to create a new one.",
      });
      return true;
    }

    const currentStore = useConsoleStore.getState();
    const currentTabs = Object.values(currentStore.tabs);
    const targetConsole = currentTabs.find((consoleTab: any) => {
      return consoleTab.id === consoleId;
    });

    if (!targetConsole) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
      });
      return true;
    }

    if ((targetConsole as any).readOnly) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "This console is shared as read-only. Use create_console to create a copy with the desired changes instead.",
      });
      return true;
    }

    if (action === "insert" && (position === null || position === undefined)) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "Position is required for insert action",
      });
      return true;
    }

    if (action === "patch" && (!startLine || !endLine)) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "startLine and endLine are required for patch action. Use read_console first to see line numbers.",
      });
      return true;
    }

    if (onConsoleModification) {
      onConsoleModification({
        action,
        content,
        position:
          position !== null && position !== undefined
            ? { line: position, column: 1 }
            : undefined,
        consoleId,
        startLine,
        endLine,
      });
    }

    const currentContent = targetConsole.content || "";
    const modification: ConsoleModification = {
      action,
      content,
      position:
        position !== null && position !== undefined
          ? { line: position, column: 1 }
          : undefined,
      startLine,
      endLine,
    };
    const newContent = applyModification(currentContent, modification);
    const diff = buildModificationDiff(currentContent, modification);
    currentStore.updateContent(consoleId, newContent);

    if (modifyTitle) {
      currentStore.updateTitle(consoleId, modifyTitle);
    }

    emitToolOutput(addToolOutput, toolName, toolCallId, {
      success: true,
      consoleId,
      title: modifyTitle ?? targetConsole.title,
      diff,
      message: `Console ${action}${action === "patch" ? "ed" : "d"} successfully`,
    });
    return true;
  }

  if (toolName === "create_console") {
    const currentStore = useConsoleStore.getState();
    const currentTabs = Object.values(currentStore.tabs);
    const currentActiveId = currentStore.activeTabId;

    const title = input.title as string;
    const content = input.content as string;
    const connectionId = (input.connectionId as string | null) ?? undefined;
    const databaseId = (input.databaseId as string | null) ?? undefined;
    const databaseName = (input.databaseName as string | null) ?? undefined;

    const baseConsole =
      currentTabs.find(
        (consoleTab: any) => consoleTab.id === capturedConsoleId,
      ) ||
      currentTabs.find(
        (consoleTab: any) => consoleTab.id === currentActiveId,
      ) ||
      currentTabs[0];

    const effectiveConnectionId = connectionId ?? baseConsole?.connectionId;
    const effectiveDatabaseId = databaseId ?? baseConsole?.databaseId;
    const effectiveDatabaseName = databaseName ?? baseConsole?.databaseName;
    const newConsoleId = generateObjectId();

    if (onConsoleModification) {
      onConsoleModification({
        action: "create",
        content,
        consoleId: newConsoleId,
        title,
        connectionId: effectiveConnectionId,
        databaseId: effectiveDatabaseId,
        databaseName: effectiveDatabaseName,
        isDirty: true,
      });
    }

    emitToolOutput(addToolOutput, toolName, toolCallId, {
      success: true,
      _eventType: "console_creation",
      consoleId: newConsoleId,
      title,
      content,
      connectionId: effectiveConnectionId,
      databaseId: effectiveDatabaseId,
      databaseName: effectiveDatabaseName,
      message: `✓ New console "${title}" created successfully`,
    });
    return true;
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

  if (toolName === "set_console_connection") {
    const consoleId = input.consoleId as string | undefined;
    const connectionId = input.connectionId as string;
    const databaseId = input.databaseId as string | undefined;
    const databaseName = input.databaseName as string | undefined;

    if (!consoleId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "consoleId is required. Use list_open_consoles to get IDs of existing consoles, or create_console to create a new one.",
      });
      return true;
    }

    const currentStore = useConsoleStore.getState();
    const currentTabs = Object.values(currentStore.tabs);
    const targetConsole = currentTabs.find((consoleTab: any) => {
      return consoleTab.id === consoleId;
    });

    if (!targetConsole) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
      });
      return true;
    }

    currentStore.updateConnection(consoleId, connectionId);
    if (databaseId !== undefined || databaseName !== undefined) {
      currentStore.updateDatabase(consoleId, databaseId, databaseName);
    }

    emitToolOutput(addToolOutput, toolName, toolCallId, {
      success: true,
      consoleId,
      connectionId,
      databaseId,
      databaseName,
      message: `Console "${targetConsole.title}" attached to connection ${connectionId}${databaseName ? ` (database: ${databaseName})` : ""}`,
    });
    return true;
  }

  if (toolName === "open_console") {
    const consoleId = input.consoleId as string | undefined;
    if (!consoleId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "consoleId is required.",
      });
      return true;
    }

    if (!workspaceId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "No workspace selected.",
      });
      return true;
    }

    const { abortController } = registerActiveClientToolCall(
      toolName,
      toolCallId,
    );

    const currentStoreForOpen = useConsoleStore.getState();
    const existingTab = currentStoreForOpen.tabs[consoleId];
    if (existingTab) {
      currentStoreForOpen.setActiveTab(consoleId);
      settleActiveClientToolCall(toolName, toolCallId, {
        success: true,
        consoleId,
        title: existingTab.title,
        message: `Console "${existingTab.title}" is already open — switched to it.`,
      });
      return true;
    }

    void (async () => {
      try {
        const data = await currentStoreForOpen.fetchConsoleContent(
          workspaceId,
          consoleId,
          {
            signal: abortController.signal,
          },
        );
        if (abortController.signal.aborted) {
          return;
        }

        if (!data) {
          settleActiveClientToolCall(toolName, toolCallId, {
            success: false,
            error: `Console ${consoleId} not found or access denied.`,
          });
          return;
        }

        const title = data.name || data.path || "Untitled";
        currentStoreForOpen.openTab({
          id: consoleId,
          title,
          content: data.content || "",
          connectionId: data.connectionId,
          databaseId: data.databaseId,
          databaseName: data.databaseName,
        });
        currentStoreForOpen.setActiveTab(consoleId);

        settleActiveClientToolCall(toolName, toolCallId, {
          success: true,
          consoleId,
          title,
          message: `Console "${title}" opened successfully.`,
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        settleActiveClientToolCall(toolName, toolCallId, {
          success: false,
          error: `Failed to open console: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
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

  if (toolName === "run_console") {
    const consoleId = input.consoleId as string | undefined;

    if (!consoleId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "consoleId is required. Use list_open_consoles to get IDs of existing consoles.",
      });
      return true;
    }

    const currentStore = useConsoleStore.getState();
    const currentTabs = Object.values(currentStore.tabs);
    const targetConsole = currentTabs.find((consoleTab: any) => {
      return consoleTab.id === consoleId;
    }) as ConsoleTab | undefined;

    if (!targetConsole) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
      });
      return true;
    }

    const content = targetConsole.content;
    const connectionId = targetConsole.connectionId;

    if (!content?.trim()) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "Console is empty. Write a query first using modify_console.",
      });
      return true;
    }

    if (!connectionId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error:
          "Console has no database connection. Use set_console_connection to attach one first.",
      });
      return true;
    }

    if (!workspaceId) {
      emitToolOutput(addToolOutput, toolName, toolCallId, {
        success: false,
        error: "No workspace selected.",
      });
      return true;
    }

    const QUERY_TIMEOUT_MS = 120_000;
    const { abortController, executionId } = registerActiveClientToolCall(
      toolName,
      toolCallId,
      {
        cancel: async () => {
          await useConsoleStore
            .getState()
            .cancelQuery(workspaceId, executionId);
        },
      },
    );
    const timeoutId = setTimeout(
      () => abortController.abort("query-timeout"),
      QUERY_TIMEOUT_MS,
    );

    window.dispatchEvent(
      new CustomEvent("console-execution-start", {
        detail: { consoleId },
      }),
    );

    // Fire-and-forget: don't block onToolCall while the query executes.
    // The AI SDK's processUIMessageStream awaits onToolCall for each chunk,
    // so a long-running await here blocks ALL subsequent SSE chunk processing
    // (including other tool calls in the same step and the finish chunks).
    // By returning immediately, the stream can close and other tools can
    // settle. When this query completes, settleActiveClientToolCall calls
    // addToolOutput which triggers auto-send once every tool has output.
    void (async () => {
      try {
        const startTime = Date.now();
        const result = await currentStore.executeQuery(
          workspaceId,
          connectionId,
          content,
          {
            executionId,
            databaseName: targetConsole.databaseName,
            databaseId: targetConsole.databaseId,
            signal: abortController.signal,
          },
        );
        clearTimeout(timeoutId);
        const executionTime = Date.now() - startTime;

        if (result.success) {
          const data = result.rows || [];
          const rowCount = Array.isArray(data) ? data.length : 1;
          const preview = Array.isArray(data) ? data.slice(0, 50) : data;

          window.dispatchEvent(
            new CustomEvent("console-execution-result", {
              detail: {
                consoleId,
                result: {
                  results: data,
                  executedAt: new Date().toISOString(),
                  resultCount: rowCount,
                  executionTime,
                  fields: result.fields,
                  pageInfo: result.pageInfo || null,
                },
              },
            }),
          );

          settleActiveClientToolCall(toolName, toolCallId, {
            success: true,
            rowCount,
            preview,
            message: `Query executed successfully. ${rowCount} row(s) returned.`,
          });
        } else {
          const abortReason =
            typeof abortController.signal.reason === "string"
              ? abortController.signal.reason
              : undefined;

          window.dispatchEvent(
            new CustomEvent("console-execution-result", {
              detail: { consoleId, result: null },
            }),
          );

          if (abortReason === "chat-stop") {
            return;
          }

          settleActiveClientToolCall(toolName, toolCallId, {
            success: false,
            error:
              abortReason === "query-timeout"
                ? `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s. The query may be too complex or the database is under heavy load.`
                : result.error || "Query execution failed.",
          });
        }
      } catch (error: any) {
        clearTimeout(timeoutId);

        const abortReason =
          typeof abortController.signal.reason === "string"
            ? abortController.signal.reason
            : undefined;

        window.dispatchEvent(
          new CustomEvent("console-execution-result", {
            detail: { consoleId, result: null },
          }),
        );

        if (abortReason === "chat-stop") {
          return;
        }

        settleActiveClientToolCall(toolName, toolCallId, {
          success: false,
          error:
            abortReason === "query-timeout"
              ? `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s. The query may be too complex or the database is under heavy load.`
              : error?.message || "Query execution failed unexpectedly.",
        });
      }
    })();
    return true;
  }

  return false;
}
