import {
  isOutboundConnector,
  type OutboundConnector,
} from "../../connectors/base/OutboundConnector";
import { databaseDataSourceManager } from "../../sync/database-data-source-manager";
import { syncConnectorRegistry } from "../../sync/connector-registry";

export async function getOutboundConnector(
  connectorId: string,
): Promise<OutboundConnector> {
  const dataSource = await databaseDataSourceManager.getDataSource(connectorId);
  if (!dataSource) {
    throw new Error("Destination connector not found");
  }

  const connector = await syncConnectorRegistry.getConnector(dataSource);
  const outbound = connector?.getOutboundCapability();
  if (!isOutboundConnector(outbound)) {
    throw new Error("Destination connector does not support outbound writes");
  }
  return outbound;
}
