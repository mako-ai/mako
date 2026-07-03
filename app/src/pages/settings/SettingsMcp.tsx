import SettingsLayout from "./SettingsLayout";
import { McpServersSection } from "../../components/McpServersSection";

export default function SettingsMcp() {
  return (
    <SettingsLayout
      title="MCP Servers"
      description="Connect Model Context Protocol servers (Close CRM, or any MCP-compatible service) to give the agent tools for external systems. Write actions ask for your approval unless you choose Always allow."
    >
      <McpServersSection />
    </SettingsLayout>
  );
}
