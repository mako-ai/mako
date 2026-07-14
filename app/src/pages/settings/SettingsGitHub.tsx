import SettingsLayout from "./SettingsLayout";
import GitHubConnectionSection from "../../components/GitHubConnectionSection";

export default function SettingsGitHub() {
  return (
    <SettingsLayout
      title="GitHub"
      description="Connect GitHub App installations and manage the repo Apps v2 uses for this workspace's apps."
    >
      <GitHubConnectionSection />
    </SettingsLayout>
  );
}
