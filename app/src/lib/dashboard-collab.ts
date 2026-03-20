type MessageHandler = (message: CollabMessage) => void;

export interface CollabMessage {
  type: "filter_change" | "widget_mutation" | "layout_change" | "cursor_move";
  userId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export class DashboardCollabClient {
  private ws: WebSocket | null = null;
  private handlers: Set<MessageHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dashboardId: string;
  private baseUrl: string;

  constructor(dashboardId: string, baseUrl?: string) {
    this.dashboardId = dashboardId;
    this.baseUrl =
      baseUrl ||
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(
        `${this.baseUrl}/api/dashboards/${this.dashboardId}/live`,
      );

      this.ws.onmessage = event => {
        try {
          const message: CollabMessage = JSON.parse(event.data);
          for (const handler of this.handlers) {
            handler(message);
          }
        } catch {
          // Invalid message format
        }
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
  }

  send(message: Omit<CollabMessage, "timestamp">): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        ...message,
        timestamp: Date.now(),
      }),
    );
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  broadcastFilterChange(filterId: string, value: unknown): void {
    this.send({
      type: "filter_change",
      userId: "",
      payload: { filterId, value },
    });
  }

  broadcastWidgetMutation(
    action: "add" | "modify" | "remove",
    widgetId: string,
    changes?: Record<string, unknown>,
  ): void {
    this.send({
      type: "widget_mutation",
      userId: "",
      payload: { action, widgetId, changes },
    });
  }

  broadcastLayoutChange(layouts: Record<string, unknown>[]): void {
    this.send({
      type: "layout_change",
      userId: "",
      payload: { layouts },
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
