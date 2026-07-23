import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, Box, Button } from "@mui/material";
import SettingsLayout from "./SettingsLayout";
import { CodingAgentsPanel } from "../../components/CodingAgentsPanel";

/** Keep a panel crash from blanking the whole settings tab. */
class CodingAgentsErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Coding Agents panel crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Box>
          <Alert severity="error" sx={{ mb: 2 }}>
            Coding Agents failed to render: {this.state.error.message}
          </Alert>
          <Button
            variant="outlined"
            size="small"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}

export default function SettingsCodingAgents() {
  return (
    <SettingsLayout
      title="Coding Agents"
      description="Run Claude Code or Codex (ChatGPT) inside Mako via the Agent Client Protocol. Adapters run on your machine through the Local Agent — your subscription pays for tokens."
      maxWidth="full"
    >
      <CodingAgentsErrorBoundary>
        <CodingAgentsPanel />
      </CodingAgentsErrorBoundary>
    </SettingsLayout>
  );
}
