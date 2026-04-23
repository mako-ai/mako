import SettingsLayout from "./SettingsLayout";
import { ApiKeyManager } from "../../components/ApiKeyManager";

export default function SettingsApiKeys() {
  return (
    <SettingsLayout title="API Keys">
      <ApiKeyManager />
    </SettingsLayout>
  );
}
