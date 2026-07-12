import npa from "npm-package-arg";
import {
  APP_V2_SESSION_MAX_PACKAGE_COUNT,
  APP_V2_SESSION_MAX_PACKAGE_SPEC_CHARACTERS,
} from "./config";
import { AppV2ValidationError } from "./errors";

const REGISTRY_SPEC_TYPES = new Set(["version", "range", "tag"]);

export function isAppV2RegistryPackageSpec(spec: string): boolean {
  if (
    !spec ||
    spec !== spec.trim() ||
    spec.length > APP_V2_SESSION_MAX_PACKAGE_SPEC_CHARACTERS ||
    spec.endsWith("@") ||
    /[\0\r\n]/.test(spec)
  ) {
    return false;
  }
  try {
    const parsed = npa(spec);
    return Boolean(
      parsed.name &&
        parsed.registry &&
        REGISTRY_SPEC_TYPES.has(parsed.type) &&
        parsed.raw === spec,
    );
  } catch {
    return false;
  }
}

export function validateAppV2PackageSpecs(packages: readonly string[]): void {
  if (
    packages.length === 0 ||
    packages.length > APP_V2_SESSION_MAX_PACKAGE_COUNT ||
    packages.some(spec => !isAppV2RegistryPackageSpec(spec))
  ) {
    throw new AppV2ValidationError(
      "Packages must be valid public npm registry package specs",
    );
  }
}
