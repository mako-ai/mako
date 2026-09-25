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
        // A class component has no hook access to the MUI theme, so the BUI
        // custom properties are read directly — they already flip with the
        // theme, which the hardcoded hex values did not.
        style={{
          border: "1px solid var(--bui-red-tint)",
          borderRadius: 6,
          color: "var(--bui-red)",
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
