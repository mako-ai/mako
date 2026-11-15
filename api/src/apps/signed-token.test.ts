import assert from "node:assert/strict";
import {
  decodeTokenBody,
  signTokenPayload,
  tokenSecret,
  verifiedTokenBody,
} from "./signed-token";

const signed = signTokenPayload({ v: 1, w: "ws" }, "s3cret");
const [body, signature] = signed.split(".");
assert.ok(body && signature);

// Round trip.
const ok = verifiedTokenBody(signed, "s3cret");
assert.ok("body" in ok);
assert.deepEqual(decodeTokenBody(ok.body), { v: 1, w: "ws" });

// Another secret, a changed body, a truncated signature: all forged.
assert.deepEqual(verifiedTokenBody(signed, "other"), { error: "signature" });
const tampered = `${Buffer.from('{"v":1,"w":"other"}').toString("base64url")}.${signature}`;
assert.deepEqual(verifiedTokenBody(tampered, "s3cret"), {
  error: "signature",
});
assert.deepEqual(verifiedTokenBody(`${body}.${signature.slice(1)}`, "s3cret"), {
  error: "signature",
});

// No signature part at all.
assert.deepEqual(verifiedTokenBody(body, "s3cret"), { error: "malformed" });
assert.deepEqual(verifiedTokenBody(".abc", "s3cret"), { error: "malformed" });

// SESSION_SECRET first, ENCRYPTION_KEY as the fallback, none → undefined.
const saved = {
  session: process.env.SESSION_SECRET,
  key: process.env.ENCRYPTION_KEY,
};
process.env.SESSION_SECRET = "a";
process.env.ENCRYPTION_KEY = "b";
assert.equal(tokenSecret(), "a");
delete process.env.SESSION_SECRET;
assert.equal(tokenSecret(), "b");
delete process.env.ENCRYPTION_KEY;
assert.equal(tokenSecret(), undefined);
if (saved.session !== undefined) process.env.SESSION_SECRET = saved.session;
if (saved.key !== undefined) process.env.ENCRYPTION_KEY = saved.key;

console.log("signed-token tests passed");
