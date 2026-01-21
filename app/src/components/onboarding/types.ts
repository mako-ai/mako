/**
 * Onboarding flow types
 */

export type OnboardingStep =
  | "loading"
  | "invites"
  | "qualification"
  | "path-selection"
  | "database-setup"
  | "creating";

export type CompanySize = "hobby" | "startup" | "growth" | "enterprise";

export interface QualificationData {
  role?: string;
  companySize?: CompanySize;
  databaseTypes?: string[];
  hasNoDatabase?: boolean;
}

export interface OnboardingData extends QualificationData {
  selectedPath?: "demo" | "connect";
  workspaceName?: string;
}

export const ROLE_OPTIONS = [
  { value: "developer", label: "Developer / Engineer" },
  { value: "analyst", label: "Data Analyst / Scientist" },
  { value: "founder", label: "Founder / Product Manager" },
  { value: "manager", label: "Engineering Manager / Team Lead" },
  { value: "other", label: "Other" },
];

export const COMPANY_SIZE_OPTIONS: { value: CompanySize; label: string }[] = [
  { value: "hobby", label: "Hobby / Personal project" },
  { value: "startup", label: "Startup (1-10 employees)" },
  { value: "growth", label: "Growth (11-100 employees)" },
  { value: "enterprise", label: "Enterprise (100+ employees)" },
];

export const DATABASE_TYPE_OPTIONS = [
  { value: "mongodb", label: "MongoDB" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "bigquery", label: "BigQuery" },
  { value: "clickhouse", label: "ClickHouse" },
  { value: "other", label: "Other" },
  { value: "none", label: "I don't have a database yet" },
];
