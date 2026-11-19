/**
 * Provider-side webhook provisioning per vendor, for boxed (`ws:`) flows.
 * The API process runs these with the connection's key, so a signing secret
 * goes straight onto the flow and never reaches a box. The registry that
 * picks one by folder slug is connectors/workspace/webhook-provisioners.ts.
 */
export type { WebhookProvisioner } from "./types";
export * from "./stripe";
export * from "./close";
export { createCloseClient } from "./close-client";
export * from "./pandadoc";
export * from "./claap";
export * from "./calendly";
export * from "./wise";
