import SettingsLayout from "./SettingsLayout";
import { McpAgentsPanel } from "../../components/McpAgentsPanel";

export default function SettingsAgents() {
  return (
    <SettingsLayout
      title="Connect Agents"
      description="Point Claude, Cursor, Codex, or any MCP client at your Mako workspace — they sign in with your account, no API key. Data access is read-only by design."
    >
      <McpAgentsPanel />
    </SettingsLayout>
  );
}
