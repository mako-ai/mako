import SettingsLayout from "./SettingsLayout";
import { CodingAgentsPanel } from "../../components/CodingAgentsPanel";

export default function SettingsCodingAgents() {
  return (
    <SettingsLayout
      title="Coding Agents"
      description="Run Claude Code or Codex (ChatGPT) inside Mako via the Agent Client Protocol. Adapters run on your machine through the Local Agent — your subscription pays for tokens."
      maxWidth="full"
    >
      <CodingAgentsPanel />
    </SettingsLayout>
  );
}
