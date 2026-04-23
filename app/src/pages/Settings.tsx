import type { SettingsSection } from "../store/lib/types";
import SettingsOpenAI from "./settings/SettingsOpenAI";
import SettingsPrompt from "./settings/SettingsPrompt";
import SettingsModels from "./settings/SettingsModels";
import SettingsBilling from "./settings/SettingsBilling";
import SettingsMembers from "./settings/SettingsMembers";
import SettingsApiKeys from "./settings/SettingsApiKeys";
import SettingsAppearance from "./settings/SettingsAppearance";
import SettingsQuery from "./settings/SettingsQuery";
import SettingsAdmin from "./settings/SettingsAdmin";

interface Props {
  /**
   * Which settings sub-page to render. When absent, falls back to the "prompt"
   * page — the most common section a user lands on after clicking the cog.
   */
  section?: SettingsSection;
}

/**
 * Tiny router that dispatches each settings tab to its own sub-page component.
 * The actual section implementations live under `./settings/*`.
 */
function Settings({ section = "prompt" }: Props) {
  switch (section) {
    case "openai":
      return <SettingsOpenAI />;
    case "prompt":
      return <SettingsPrompt />;
    case "models":
      return <SettingsModels />;
    case "billing":
      return <SettingsBilling />;
    case "members":
      return <SettingsMembers />;
    case "api-keys":
      return <SettingsApiKeys />;
    case "appearance":
      return <SettingsAppearance />;
    case "query":
      return <SettingsQuery />;
    case "admin":
      return <SettingsAdmin />;
    default:
      return <SettingsPrompt />;
  }
}

export default Settings;
