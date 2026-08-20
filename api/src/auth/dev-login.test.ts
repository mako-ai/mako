/**
 * The dev-login bypass is a deliberate hole in authentication, so each guard
 * is pinned independently: the test asserts that removing ANY ONE of them
 * closes the hole, not merely that the happy path works.
 */
import assert from "node:assert/strict";
import {
  MIN_SECRET_LENGTH,
  assertDevLoginSafeAtBoot,
  devLoginEnabledForRequest,
  devLoginSecret,
  isLoopbackHost,
  matchesDevLoginSecret,
} from "./dev-login";

const SECRET = "local-dev-secret-value";
assert.ok(SECRET.length >= MIN_SECRET_LENGTH);

const originalEnv = { ...process.env };
function setEnv(nodeEnv: string | undefined, secret: string | undefined): void {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (secret === undefined) delete process.env.DEV_LOGIN_PASSWORD;
  else process.env.DEV_LOGIN_PASSWORD = secret;
}

// --- Guard 3: only loopback hosts ------------------------------------------
for (const host of [
  "localhost",
  "localhost:5173",
  "127.0.0.1",
  "127.0.0.1:8080",
  "::1",
  "[::1]:8080",
  "LOCALHOST:8080",
]) {
  assert.ok(isLoopbackHost(host), `${host} should count as loopback`);
}
for (const host of [
  "pr-697.mako.ai",
  "app.mako.ai",
  "localhost.evil.com",
  "127.0.0.1.evil.com",
  "notlocalhost",
  "",
  undefined,
]) {
  assert.ok(
    !isLoopbackHost(host),
    `${String(host)} must NOT count as loopback`,
  );
}

// --- Happy path: every guard satisfied -------------------------------------
setEnv("development", SECRET);
assert.equal(devLoginSecret(), SECRET);
assert.ok(devLoginEnabledForRequest("localhost:5173"));
assert.ok(matchesDevLoginSecret(SECRET));

// --- Guard 1: production disables it, even with everything else right ------
setEnv("production", SECRET);
assert.equal(devLoginSecret(), null, "production must disable dev login");
assert.ok(!devLoginEnabledForRequest("localhost:5173"));
assert.ok(!matchesDevLoginSecret(SECRET));

// --- Guard 4: and production must refuse to boot at all --------------------
assert.throws(
  () => assertDevLoginSafeAtBoot(),
  /must never be present in a deployed environment/,
  "production + DEV_LOGIN_PASSWORD must be a boot failure",
);
setEnv("production", undefined);
assert.doesNotThrow(
  () => assertDevLoginSafeAtBoot(),
  "production without the variable is fine",
);

// --- Guard 2: unset / blank / too-short all mean OFF -----------------------
setEnv("development", undefined);
assert.equal(devLoginSecret(), null, "unset means off");
assert.ok(!matchesDevLoginSecret(""), "empty candidate never matches");

setEnv("development", "   ");
assert.equal(devLoginSecret(), null, "blank means off");

const short = "x".repeat(MIN_SECRET_LENGTH - 1);
setEnv("development", short);
assert.equal(devLoginSecret(), null, "too-short secret must be treated as off");
assert.ok(
  !matchesDevLoginSecret(short),
  "a too-short secret must not authenticate even if quoted back exactly",
);

// --- Guard 3 again, at the request level -----------------------------------
setEnv("development", SECRET);
assert.ok(
  !devLoginEnabledForRequest("pr-697.mako.ai"),
  "a deployed Host must disable dev login even in a non-production process",
);
assert.ok(
  !devLoginEnabledForRequest(undefined),
  "a missing Host is not loopback",
);

// --- Wrong secrets never match --------------------------------------------
assert.ok(!matchesDevLoginSecret(`${SECRET}x`), "longer candidate must fail");
assert.ok(!matchesDevLoginSecret(SECRET.slice(0, -1)), "shorter must fail");
assert.ok(!matchesDevLoginSecret("wrong-but-same-length!"), "wrong must fail");

process.env = originalEnv;
console.log("dev-login.test.ts: all assertions passed");
