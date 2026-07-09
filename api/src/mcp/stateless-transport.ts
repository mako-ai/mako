/**
 * Stateless in-memory MCP transport for one-shot HTTP handling.
 *
 * The official StreamableHTTPServerTransport writes directly to Node's
 * req/res, which couples the endpoint to the node-server adapter. This
 * transport instead collects the server's outgoing JSON-RPC messages in
 * memory so the route handler can return them as a plain fetch-style JSON
 * response ("enableJsonResponse" mode of the Streamable HTTP spec). One
 * transport + Server pair is created per HTTP request and discarded —
 * no sessions, no SSE resumption.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type RequestId = string | number;

function isResponse(message: JSONRPCMessage): boolean {
  return "result" in message || "error" in message;
}

export class StatelessMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private outgoing: JSONRPCMessage[] = [];
  private pendingIds = new Set<RequestId>();
  private settle: (() => void) | null = null;

  async start(): Promise<void> {
    // No connection to establish — messages are pushed via handle().
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.outgoing.push(message);
    if (isResponse(message) && "id" in message && message.id !== undefined) {
      this.pendingIds.delete(message.id as RequestId);
      if (this.pendingIds.size === 0) this.settle?.();
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * Feed the incoming message(s) to the server and wait until every request
   * id has received a response (or the timeout elapses). Returns only the
   * responses matching the ids of this batch — server-originated
   * notifications have no receiver in a stateless exchange and are dropped.
   */
  async handle(
    messages: JSONRPCMessage[],
    timeoutMs: number,
  ): Promise<JSONRPCMessage[]> {
    const requestIds = new Set<RequestId>();
    for (const message of messages) {
      if ("method" in message && "id" in message && message.id !== undefined) {
        requestIds.add(message.id as RequestId);
        this.pendingIds.add(message.id as RequestId);
      }
    }

    const done =
      this.pendingIds.size > 0
        ? new Promise<void>(resolve => {
            this.settle = resolve;
          })
        : Promise.resolve();

    for (const message of messages) {
      this.onmessage?.(message);
    }

    if (this.pendingIds.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([done, timeout]);
      if (timer) clearTimeout(timer);
    }

    // Synthesize timeouts for anything the server never answered so the
    // client is not left hanging on a request id.
    for (const id of this.pendingIds) {
      if (!requestIds.has(id)) continue;
      this.outgoing.push({
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "Request timed out" },
      } as JSONRPCMessage);
    }

    return this.outgoing.filter(
      message =>
        isResponse(message) &&
        "id" in message &&
        requestIds.has(message.id as RequestId),
    );
  }
}
