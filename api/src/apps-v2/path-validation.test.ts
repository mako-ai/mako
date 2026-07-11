import assert from "node:assert/strict";
import {
  assertNoAppV2CaseCollisions,
  validateAppV2Path,
} from "./path-validation";

assert.equal(
  validateAppV2Path("src/components/Card.tsx"),
  "src/components/Card.tsx",
);

for (const invalid of [
  "",
  "/etc/passwd",
  "../secret",
  "src/../secret",
  "src\\App.tsx",
  "src//App.tsx",
  "./src/App.tsx",
  ".git/config",
  "src/.GIT/config",
  "nul\0byte",
]) {
  assert.throws(() => validateAppV2Path(invalid), undefined, invalid);
}

assert.doesNotThrow(() =>
  assertNoAppV2CaseCollisions(["src/App.tsx", "src/styles.css"]),
);
assert.throws(() =>
  assertNoAppV2CaseCollisions(["src/App.tsx", "SRC/app.tsx"]),
);
assert.throws(() => assertNoAppV2CaseCollisions(["public", "public/icon.svg"]));
