import assert from "node:assert/strict";
import { loginRedirectUrl, shouldRedirectToLogin } from "./login-redirect";

const WS = "6846e6a01b05af0948070582";
const LIVE = `/api/workspaces/${WS}/apps/6a94114ba81bc22f38ff8c3a/live/`;

// A person opening a published app in a tab: send them to the login screen.
assert.equal(
  shouldRedirectToLogin({
    method: "GET",
    path: LIVE,
    accept: "text/html,application/xhtml+xml",
    secFetchDest: "document",
  }),
  true,
);

// The app's own binding fetches parse the JSON 401 — a login page would be
// unparseable garbage to them.
assert.equal(
  shouldRedirectToLogin({
    method: "GET",
    path: `${LIVE}__data/fr_demos.parquet`,
    accept: "*/*",
    secFetchDest: "empty",
  }),
  false,
);

// The published viewer renders inside a sandboxed iframe; a login screen in
// there helps nobody.
assert.equal(
  shouldRedirectToLogin({ method: "GET", path: LIVE, secFetchDest: "iframe" }),
  false,
);

// Writes, and the auth surface itself (a redirect loop starts here).
assert.equal(
  shouldRedirectToLogin({
    method: "POST",
    path: LIVE,
    secFetchDest: "document",
  }),
  false,
);
assert.equal(
  shouldRedirectToLogin({
    method: "GET",
    path: "/api/auth/session",
    secFetchDest: "document",
  }),
  false,
);

// No Sec-Fetch-Dest (older clients): fall back to Accept.
assert.equal(
  shouldRedirectToLogin({ method: "GET", path: LIVE, accept: "text/html" }),
  true,
);
assert.equal(
  shouldRedirectToLogin({
    method: "GET",
    path: LIVE,
    accept: "application/json",
  }),
  false,
);
assert.equal(shouldRedirectToLogin({ method: "GET", path: LIVE }), false);

// returnTo carries the whole URL back, query included, and is encoded so the
// login page reads one parameter rather than three.
assert.equal(
  loginRedirectUrl(LIVE),
  `/login?returnTo=${encodeURIComponent(LIVE)}`,
);
assert.equal(
  loginRedirectUrl(LIVE, "?rep=Chich&v=cohort"),
  `/login?returnTo=${encodeURIComponent(`${LIVE}?rep=Chich&v=cohort`)}`,
);
assert.equal(
  loginRedirectUrl(LIVE, "rep=Chich"),
  `/login?returnTo=${encodeURIComponent(`${LIVE}?rep=Chich`)}`,
);
// Only relative paths ever reach returnTo, which is what the login page
// requires (safeReturnTo rejects anything not starting with a single "/").
assert.ok(loginRedirectUrl(LIVE).includes(encodeURIComponent("/api/")));

console.log("login-redirect tests passed");
