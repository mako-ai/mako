import SettingsLayout from "./SettingsLayout";
import SlackIntegrationCard from "../../components/SlackIntegrationCard";

export default function SettingsIntegrations() {
  return (
    <SettingsLayout title="Integrations">
      <SlackIntegrationCard />
    </SettingsLayout>
  );
}
