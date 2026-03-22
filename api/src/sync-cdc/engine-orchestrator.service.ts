import { BaseConnector } from "../connectors/base/BaseConnector";
import { NormalizedCdcEvent } from "./contracts/events";
import { cdcIngestService } from "./ingest.service";

export class CdcEngineOrchestratorService {
  async ingestBackfill(params: {
    workspaceId: string;
    flowId: string;
    connector: BaseConnector;
    connectorType?: string;
    entity: string;
    records: Array<Record<string, unknown>>;
    runId?: string;
    enqueue?: boolean;
  }) {
    return cdcIngestService.appendBackfillRecords(params);
  }

  async ingestNormalized(params: {
    workspaceId: string;
    flowId: string;
    events: NormalizedCdcEvent[];
    enqueue?: boolean;
  }) {
    return cdcIngestService.appendNormalizedEvents(params);
  }
}

export const cdcEngineOrchestratorService = new CdcEngineOrchestratorService();
