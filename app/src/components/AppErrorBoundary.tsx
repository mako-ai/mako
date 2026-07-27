import React from "react";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  onReload?: () => void;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort renderer boundary. Without this, an uncaught React render error
 * unmounts the root and leaves Electron showing only its dark window
 * background.
 */
export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[mako-renderer-error]", error, info.componentStack);
  }

  private reload = (): void => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main
        role="alert"
        style={{
          alignItems: "center",
          background: "#111418",
          color: "#f5f7f8",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          height: "100vh",
          justifyContent: "center",
          padding: 32,
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>Mako hit a display error</h1>
        <p style={{ color: "#aeb7be", margin: 0, maxWidth: 520 }}>
          Your work is still saved. Reload the window to reconnect and continue.
        </p>
        <pre
          style={{
            background: "#1a1f23",
            border: "1px solid #30383e",
            borderRadius: 6,
            color: "#e4e8eb",
            margin: 0,
            maxWidth: 720,
            overflow: "auto",
            padding: 12,
            textAlign: "left",
            whiteSpace: "pre-wrap",
          }}
        >
          {this.state.error.message || "Unknown renderer error"}
        </pre>
        <button
          type="button"
          onClick={this.reload}
          style={{
            background: "#1976d2",
            border: 0,
            borderRadius: 6,
            color: "#fff",
            cursor: "pointer",
            font: "inherit",
            padding: "9px 16px",
          }}
        >
          Reload Mako
        </button>
      </main>
    );
  }
}
