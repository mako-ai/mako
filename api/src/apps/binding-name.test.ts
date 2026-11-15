import assert from "node:assert/strict";
import { isValidBindingName } from "./binding-name";

for (const ok of ["orders", "Orders_2024", "_private", "daily-revenue", "9"]) {
  assert.equal(isValidBindingName(ok), true, ok);
}
for (const bad of [
  "",
  "-leading-dash",
  "../secrets",
  "a/b",
  "orders.sql",
  "with space",
  "naïve",
]) {
  assert.equal(isValidBindingName(bad), false, bad);
}

console.log("binding-name tests passed");
