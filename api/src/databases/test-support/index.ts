export { normalizeSql, sqlContains } from "./normalize-sql";
export {
  makeFakeConnection,
  FAKE_BIGQUERY_SERVICE_ACCOUNT,
} from "./fake-connection";
export {
  makeCapturingDriver,
  type CapturingDriver,
  type CapturedQuery,
  type QueryResponder,
  type ExecuteQueryResult,
} from "./capturing-driver";
