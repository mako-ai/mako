import SettingsLayout from "./SettingsLayout";
import GitHubConnectionSection from "../../components/GitHubConnectionSection";

export default function SettingsGitHub() {
  return (
    <SettingsLayout
      title="GitHub"
      description="Connect the GitHub repository that holds this workspace's apps, consoles, dbt, and skills."
    >
      <GitHubConnectionSection />
    </SettingsLayout>
  );
}
