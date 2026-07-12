import { getAppsV2SandboxConfiguration } from "../config";
import { E2BSandboxProvider } from "./e2b-sandbox-provider";
import type { SandboxProvider } from "./sandbox-provider";

export function createAppsV2SandboxProvider(): SandboxProvider | undefined {
  const configuration = getAppsV2SandboxConfiguration();
  if (!configuration.available) return undefined;
  return new E2BSandboxProvider(
    configuration.apiKey,
    configuration.templateId,
    configuration.user,
  );
}
