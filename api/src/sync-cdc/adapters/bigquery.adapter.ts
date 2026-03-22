import {
  CdcDestinationAdapter,
  CdcEntityLayout,
  CdcMaterializationResult,
  CdcMaterializationRun,
} from "../contracts/adapters";
import { materializeBigQueryEntity } from "./bigquery/materialization";

export class BigQueryDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "bigquery";

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    // Table creation is handled lazily in DestinationWriter.writeBatch()
  }

  async materializeEntity(
    run: CdcMaterializationRun,
    _fencingToken: number,
  ): Promise<CdcMaterializationResult> {
    return materializeBigQueryEntity({
      workspaceId: run.workspaceId,
      flowId: run.flowId,
      entity: run.entity,
      maxEvents: run.maxEvents,
    });
  }
}
