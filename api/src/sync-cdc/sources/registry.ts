import { BaseConnector } from "../../connectors/base/BaseConnector";
import { CdcSourceAdapter } from "../contracts/adapters";
import { BaseConnectorCdcAdapter } from "./base-connector-cdc.adapter";

export function resolveCdcSourceAdapter(params: {
  connector: BaseConnector;
  connectorType?: string;
}): CdcSourceAdapter {
  return new BaseConnectorCdcAdapter(params.connector);
}
