import { BaseConnector } from "../connectors/base/BaseConnector";
import { NormalizedCdcEvent } from "./contracts/cdc-event";
import { cdcIngestService } from "./ingest.service";
import { cdcMaterializerService } from "./materializer.service";

export class CdcEngineOrchestratorService {
  async ingestWebhook(params: {
    workspaceId: string;
    flowId: string;
    connector: BaseConnector;
    connectorType?: string;
    event: unknown;
    eventType?: string;
    runId?: string;
  }) {
    return cdcIngestService.appendWebhookPayload(params);
  }

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

  async materializeEntity(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    maxEvents?: number;
  }) {
    return cdcMaterializerService.materializeEntity(params);
  }
}

export const cdcEngineOrchestratorService = new CdcEngineOrchestratorService();
