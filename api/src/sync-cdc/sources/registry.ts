import { BaseConnector } from "../../connectors/base/BaseConnector";
import { CdcSourceAdapter } from "../contracts/source-adapter";
import { BaseConnectorCdcAdapter } from "./base-connector-cdc.adapter";

type SourceAdapterFactory = (connector: BaseConnector) => CdcSourceAdapter;

const sourceAdapterFactories = new Map<string, SourceAdapterFactory>();

export function registerCdcSourceAdapter(
  connectorType: string,
  factory: SourceAdapterFactory,
) {
  sourceAdapterFactories.set(connectorType, factory);
}

export function resolveCdcSourceAdapter(params: {
  connector: BaseConnector;
  connectorType?: string;
}): CdcSourceAdapter {
  const typedConnector = params.connector as BaseConnector & {
    getCdcSourceAdapter?: () => CdcSourceAdapter | undefined;
  };
  if (typeof typedConnector.getCdcSourceAdapter === "function") {
    const adapter = typedConnector.getCdcSourceAdapter();
    if (adapter) return adapter;
  }

  if (params.connectorType) {
    const factory = sourceAdapterFactories.get(params.connectorType);
    if (factory) {
      return factory(params.connector);
    }
  }

  return new BaseConnectorCdcAdapter(params.connector);
}
