import React from "react";

interface ChatPanelErrorBoundaryProps {
  children: React.ReactNode;
  /** Short name used in the log line and the fallback text. */
  panel: string;
  /** Any change to this value clears a previous failure (e.g. session id). */
  resetKey?: unknown;
}

interface ChatPanelErrorBoundaryState {
  failed: boolean;
}

/**
 * Isolates one chat sub-panel (permission banners, plan/question cards,
 * queued prompts) so a render error there cannot unmount the composer and the
 * message list along with it.
 */
export class ChatPanelErrorBoundary extends React.Component<
  ChatPanelErrorBoundaryProps,
  ChatPanelErrorBoundaryState
> {
  state: ChatPanelErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChatPanelErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      "[mako-chat-panel-render-error]",
      this.props.panel,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(previousProps: ChatPanelErrorBoundaryProps): void {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        role="alert"
        // Class component: no theme hook, so read the BUI custom properties
        // (they flip with the theme) like ChatMessageErrorBoundary does.
        style={{
          border: "1px solid var(--bui-red-tint)",
          borderRadius: 6,
          color: "var(--bui-red)",
          margin: "8px 0",
          padding: "8px 12px",
        }}
      >
        The {this.props.panel} could not be displayed. The rest of the chat is
        still running.
      </div>
    );
  }
}
