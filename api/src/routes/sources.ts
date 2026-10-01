/**
 * @deprecated import from `./source-connections`. Historical filename — this
 * router manages source connections (credentials), not connector code.
 */
export {
  sourceConnectionRoutes,
  sourceConnectionRoutes as dataSourceRoutes,
  applySchemaEncryption,
  SecretEncryptionError,
} from "./source-connections";
export type { ConnectorFieldSchema } from "./source-connections";
