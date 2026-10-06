/**
 * The process library. To add a process: create `<id>.ts` next to this file
 * (default-export `defineProcess(...)`) and add it to the list below.
 */
import type { ProcessDefinition } from "../sdk";
import dsarErasure from "./dsar-erasure";
import churnRiskReview from "./churn-risk-review";
import leadEnrichment from "./lead-enrichment";
import competitorWatch from "./competitor-watch";

export const libraryProcesses: ProcessDefinition[] = [
  dsarErasure,
  churnRiskReview,
  leadEnrichment,
  competitorWatch,
];
