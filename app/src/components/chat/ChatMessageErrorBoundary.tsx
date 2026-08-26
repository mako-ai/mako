import React from "react";

interface ChatMessageErrorBoundaryProps {
  children: React.ReactNode;
  messageId: string;
  messageRevision: unknown;
}

interface ChatMessageErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps one malformed or unsupported streamed message from tearing down Chat
 * and its ACP event subscription.
 */
export class ChatMessageErrorBoundary extends React.Component<
  ChatMessageErrorBoundaryProps,
  ChatMessageErrorBoundaryState
> {
  state: ChatMessageErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChatMessageErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      "[mako-chat-message-render-error]",
      this.props.messageId,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(previousProps: ChatMessageErrorBoundaryProps): void {
    if (
      this.state.failed &&
      (previousProps.messageId !== this.props.messageId ||
        previousProps.messageRevision !== this.props.messageRevision)
    ) {
      this.setState({ failed: false });
    }
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          border: "1px solid rgba(211, 47, 47, 0.45)",
          borderRadius: 6,
          color: "#d32f2f",
          margin: "8px 16px",
          padding: "10px 12px",
        }}
      >
        This message could not be displayed. The rest of the chat is still
        running.
      </div>
    );
  }
}
