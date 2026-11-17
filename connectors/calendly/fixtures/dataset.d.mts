// Types for dataset.mjs, for the API tests that import it.

export const BASE: string;
export const ORG_URI: string;
export const USER_URI: string;
export const GONE_EVENT: number;
export const BIG_EVENT: number;

export function buildDataset(): {
  me: { resource: Record<string, any> };
  organization: Record<string, any>;
  lists: Record<string, Array<Record<string, any>>>;
  invitees: Map<string, Array<Record<string, any>>>;
  goneEvent: string;
};
