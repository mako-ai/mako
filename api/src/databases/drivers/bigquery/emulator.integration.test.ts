import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { BigQuery } from "@google-cloud/bigquery";
import { BigQueryDatabaseDriver } from "./driver";
import { databaseConnectionService } from "../../../services/database-connection.service";
import {
  makeFakeConnection,
  FAKE_BIGQUERY_SERVICE_ACCOUNT,
} from "../../test-support";
import {
  bigQueryEmulatorEndpoint,
  bigQueryEmulatorHostPort,
} from "../../../utils/bigquery-emulator";

/**
 * Gated, seam-focused integration for the local BigQuery emulator
 * (ghcr.io/goccy/bigquery-emulator). Validates that both client stacks reach
 * the emulator with NO real GCP auth:
 *  - the SDK path (`apiEndpoint` + BIGQUERY_EMULATOR_HOST) — used by CDC loads;
 *  - the custom REST path (dummy bearer) — used by driver writes / queries.
 *
 * Kept intentionally minimal (dataset autocreate + `SELECT 1`) because the
 * emulator only supports a subset of BigQuery SQL (no QUALIFY/MERGE,
 * limited INFORMATION_SCHEMA, no `__TABLES__`). Broader DML coverage should be
 * added behind the same gate as emulator support firms up.
 *
 * Skipped unless RUN_DB_INTEGRATION=1 (requires Docker).
 */
const RUN =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_DB_INTEGRATION === "true";

const PROJECT_ID = "test-project";
const EMULATOR_IMAGE = "ghcr.io/goccy/bigquery-emulator:latest";

describe.skipIf(!RUN)("BigQuery emulator seam", () => {
  let container: StartedTestContainer;
  let apiBaseUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer(EMULATOR_IMAGE)
      .withExposedPorts(9050)
      .withCommand([`--project=${PROJECT_ID}`, "--port=9050"])
      .withWaitStrategy(Wait.forLogMessage(/listening|gRPC server/i))
      .start();
    apiBaseUrl = `http://${container.getHost()}:${container.getMappedPort(
      9050,
    )}`;
  }, 180_000);

  afterAll(async () => {
    delete process.env.BIGQUERY_EMULATOR_HOST;
    await (
      databaseConnectionService as unknown as {
        closeAllConnections?: () => Promise<void>;
      }
    ).closeAllConnections?.();
    if (container) await container.stop();
  });

  it("SDK path autocreates a dataset without real credentials", async () => {
    process.env.BIGQUERY_EMULATOR_HOST = bigQueryEmulatorHostPort(apiBaseUrl);
    const bq = new BigQuery({
      projectId: PROJECT_ID,
      apiEndpoint: bigQueryEmulatorEndpoint(apiBaseUrl),
    });
    const [dataset] = await bq.dataset("ds").get({ autoCreate: true });
    expect(dataset).toBeTruthy();
  });

  it("REST path runs a query with the dummy bearer (OAuth bypassed)", async () => {
    const conn = makeFakeConnection("bigquery", {
      project_id: PROJECT_ID,
      api_base_url: apiBaseUrl,
      service_account_json: FAKE_BIGQUERY_SERVICE_ACCOUNT,
    });
    const driver = new BigQueryDatabaseDriver();
    const res = await driver.executeQuery(conn, "SELECT 1 AS n");
    expect(res.success).toBe(true);
    const rows = (res.data as Array<{ n: number | string }>) ?? [];
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
