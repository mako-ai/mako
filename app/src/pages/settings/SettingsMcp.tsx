import SettingsLayout from "./SettingsLayout";
import { McpServersSection } from "../../components/McpServersSection";

export default function SettingsMcp() {
  return (
    <SettingsLayout
      title="MCP Servers"
      description="Connect Model Context Protocol servers (Close CRM, or any MCP-compatible service) to give the agent tools for external systems. Read tools run freely; write actions ask for approval unless you Always allow a tool or the whole server."
    >
      <McpServersSection />
    </SettingsLayout>
  );
}
