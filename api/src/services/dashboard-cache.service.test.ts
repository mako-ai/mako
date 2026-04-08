import assert from "node:assert/strict";
import { resolveDashboardArtifactRevision } from "./dashboard-cache.service";

function testFallsBackToParquetBuiltAtWhenRevisionMissing() {
  assert.equal(
    resolveDashboardArtifactRevision({
      parquetBuiltAt: "2026-04-08T15:35:08.836Z",
    }),
    String(Date.parse("2026-04-08T15:35:08.836Z")),
  );
}

function testPrefersNewerParquetBuiltAtOverStaleArtifactRevision() {
  assert.equal(
    resolveDashboardArtifactRevision({
      artifactRevision: "1775662508836",
      parquetBuiltAt: "2026-04-08T15:37:06.840Z",
    }),
    String(Date.parse("2026-04-08T15:37:06.840Z")),
  );
}

function testKeepsArtifactRevisionWhenItIsNewerThanBuiltAt() {
  assert.equal(
    resolveDashboardArtifactRevision({
      artifactRevision: "1775662600000",
      parquetBuiltAt: "2026-04-08T15:35:08.836Z",
    }),
    "1775662600000",
  );
}

function main() {
  testFallsBackToParquetBuiltAtWhenRevisionMissing();
  testPrefersNewerParquetBuiltAtOverStaleArtifactRevision();
  testKeepsArtifactRevisionWhenItIsNewerThanBuiltAt();
}

main();
