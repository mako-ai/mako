import SettingsLayout from "./SettingsLayout";
import { SkillsSection } from "../../components/SkillsSection";

export default function SettingsSkills() {
  return (
    <SettingsLayout
      title="Skills"
      description="Named, workspace-scoped playbooks the agent can author and load on demand. Each skill has a loadWhen trigger and a body of schema facts, gotchas, or query patterns. Suppress to A/B whether a skill is helping; delete to retract permanently."
    >
      <SkillsSection />
    </SettingsLayout>
  );
}
