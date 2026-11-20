import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  SafeRequestError,
  checkUrl,
  isBlockedAddress,
  planRedirect,
  safeRequest,
} from "./safe-request.js";

/** A local server. `seen` records the requests that reached it. */
async function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res, seen);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  return { port: server.address().port, seen };
}

/** A `dns.lookup`-shaped resolver from a name to address list (or a function). */
const resolverFor = table => {
  const calls = [];
  const resolve = (hostname, _options, callback) => {
    calls.push(hostname);
    const answer =
      typeof table === "function"
        ? table(hostname, calls.length)
        : table[hostname];
    if (!answer)
      return callback(
        Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
        [],
      );
    callback(
      null,
      answer.map(address => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  };
  resolve.calls = calls;
  return resolve;
};

const ok = (res, body = "ok") => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(body);
};

// ---------------------------------------------------------------------------
// DNS rebinding
// ---------------------------------------------------------------------------

test("rebinding: a public answer for a guard, 127.0.0.1 for the socket, is refused and nothing is sent", async () => {
  const { port, seen } = await serve((_req, res) => ok(res));
  // 93.184.216.34 on the first lookup (what a separate guard would see),
  // 127.0.0.1 on every later one (what the socket would get).
  const resolve = resolverFor((_host, n) =>
    n === 1 ? ["93.184.216.34"] : ["127.0.0.1"],
  );
  await new Promise(done => resolve("rebind.test", {}, () => done())); // the guard's lookup
  await assert.rejects(
    safeRequest(`http://rebind.test:${port}/`, {
      headers: { authorization: "Bearer SECRET-TOKEN" },
      resolve,
      allowLoopback: false,
    }),
    error =>
      error instanceof SafeRequestError && error.code === "BLOCKED_ADDRESS",
  );
  assert.equal(
    seen.length,
    0,
    "no request reached the server, so no header was sent",
  );
  assert.equal(
    resolve.calls.length,
    2,
    "the request resolved the name exactly once",
  );
});

test("rebinding to the metadata address is refused", async () => {
  const resolve = resolverFor({ "rebind.test": ["169.254.169.254"] });
  await assert.rejects(
    safeRequest("http://rebind.test/", { resolve, allowLoopback: true }),
    {
      code: "BLOCKED_ADDRESS",
    },
  );
});

test("one blocked address among public ones refuses the name", async () => {
  const resolve = resolverFor({
    "mixed.test": ["93.184.216.34", "169.254.169.254"],
  });
  await assert.rejects(safeRequest("http://mixed.test/", { resolve }), {
    code: "BLOCKED_ADDRESS",
  });
});

test("the socket connects to the address that was checked", async () => {
  const { port, seen } = await serve((_req, res) => ok(res));
  const resolve = resolverFor({ "pinned.test": ["127.0.0.1"] });
  const response = await safeRequest(`http://pinned.test:${port}/x`, {
    resolve,
    allowLoopback: true,
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.host, `pinned.test:${port}`);
  assert.equal(resolve.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

const BLOCKED = [
  // IPv4
  "0.0.0.0",
  "0.1.2.3",
  "10.0.0.1",
  "100.64.0.1",
  "100.127.255.255",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.19.255.255",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.254",
  "255.255.255.255",
  // IPv6
  "::",
  "fe80::1",
  "fec0::1",
  "fc00::1",
  "fd00::1",
  "ff02::1",
  "64:ff9b::a9fe:a9fe",
  "64:ff9b::7f00:1",
  "64:ff9b:1::1",
  "100::1",
  "100::ffff:ffff:ffff:ffff",
  "::a9fe:a9fe",
  "::10.0.0.1",
  "::ffff:0:a9fe:a9fe",
  "0:0:0:0:ffff:0:a00:1",
  "::ffff:169.254.169.254",
  "::ffff:a9fe:a9fe",
  "::ffff:10.0.0.1",
  "::ffff:0a00:0001",
  "2002:a00:1::",
  "2002:a9fe:a9fe::1",
  "2002:c0a8:101::1",
  "2002:7f00:1::1",
  "2001::1",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  "2001:2::1",
  "2001:10::1",
  "2001:db8::1",
  "3fff::1",
  "3fff:fff::1",
  "1::1",
  "not-an-ip",
  "1.2.3",
  "256.1.1.1",
];
const PUBLIC = [
  "1.1.1.1",
  "8.8.8.8",
  "93.184.216.34",
  "172.15.255.255",
  "172.32.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "198.17.255.255",
  "198.20.0.1",
  "223.255.255.255",
  "169.253.0.1",
  "2606:2800::1",
  "2a00:1450:4001::1",
  "2001:4860:4860::8888",
  "2002:5db8:d822::1",
  "::ffff:93.184.216.34",
  "::ffff:5db8:d822",
];
const LOOPBACK = [
  "127.0.0.1",
  "127.255.255.254",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
];

test("allowlist: every non-public form is blocked, with and without loopback", () => {
  for (const address of BLOCKED) {
    assert.equal(isBlockedAddress(address), true, address);
    assert.equal(
      isBlockedAddress(address, { allowLoopback: true }),
      true,
      `${address} (loopback allowed)`,
    );
  }
});

test("allowlist: public unicast passes", () => {
  for (const address of PUBLIC) {
    assert.equal(isBlockedAddress(address), false, address);
    assert.equal(
      isBlockedAddress(address, { allowLoopback: true }),
      false,
      address,
    );
  }
});

test("allowlist: loopback passes only when the caller opts in", () => {
  for (const address of LOOPBACK) {
    assert.equal(isBlockedAddress(address), true, address);
    assert.equal(
      isBlockedAddress(address, { allowLoopback: true }),
      false,
      `${address} (loopback allowed)`,
    );
  }
});

test("IPv4 literals in decimal, octal and hex are blocked as the address they name", () => {
  // 169.254.169.254 is 2852039166, 0251.0376.0251.0376, 0xa9fea9fe and 0xa9.0xfe.0xa9.0xfe.
  for (const host of [
    "2852039166",
    "0251.0376.0251.0376",
    "0xa9fea9fe",
    "0xa9.0xfe.0xa9.0xfe",
    "025177524776",
    "169.254.43518",
  ]) {
    assert.throws(
      () => checkUrl(`http://${host}/`, { allowLoopback: true }),
      { code: "BLOCKED_HOST" },
      host,
    );
  }
  // 127.0.0.1 and 10.0.0.1 in the same spellings.
  for (const host of [
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "0x7f.1",
    "127.1",
  ]) {
    assert.throws(
      () => checkUrl(`http://${host}/`),
      { code: "BLOCKED_HOST" },
      host,
    );
    assert.doesNotThrow(
      () => checkUrl(`http://${host}/`, { allowLoopback: true }),
      host,
    );
  }
  for (const host of ["167772161", "012.0.0.1", "0xa000001"]) {
    assert.throws(
      () => checkUrl(`http://${host}/`, { allowLoopback: true }),
      { code: "BLOCKED_HOST" },
      host,
    );
  }
  // A public address in the same spelling passes: 1.1.1.1 is 16843009.
  assert.doesNotThrow(() => checkUrl("http://16843009/"));
});

test("metadata names, IPv6 literals and bad URLs", () => {
  for (const host of [
    "metadata",
    "metadata.google.internal",
    "metadata.google.internal.",
    "a.b.internal",
    "[::ffff:169.254.169.254]",
    "[fd00::1]",
    "[64:ff9b::a9fe:a9fe]",
  ]) {
    assert.throws(
      () => checkUrl(`http://${host}/`, { allowLoopback: true }),
      { code: "BLOCKED_HOST" },
      host,
    );
  }
  assert.throws(() => checkUrl("ftp://example.com/"), { code: "BAD_URL" });
  assert.throws(() => checkUrl("http://user:pw@example.com/"), {
    code: "BAD_URL",
  });
  assert.throws(() => checkUrl("nope"), { code: "BAD_URL" });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

test("a redirect is returned, not followed, unless asked", async () => {
  const { port, seen } = await serve((_req, res) => {
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  const response = await safeRequest(`http://127.0.0.1:${port}/`, {
    allowLoopback: true,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/elsewhere");
  assert.equal(seen.length, 1);
});

test("every redirect hop is checked again", async () => {
  const target = async location => {
    const { port, seen } = await serve((_req, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    return { url: `http://127.0.0.1:${port}/start?token=Q1`, seen };
  };
  const common = { allowLoopback: true, followRedirects: true };
  // A literal.
  let hop = await target("http://169.254.169.254/latest/meta-data");
  await assert.rejects(safeRequest(hop.url, common), { code: "BLOCKED_HOST" });
  // A name that resolves to a blocked address.
  hop = await target("http://evil.test/");
  await assert.rejects(
    safeRequest(hop.url, {
      ...common,
      resolve: resolverFor({ "evil.test": ["10.1.2.3"] }),
    }),
    { code: "BLOCKED_ADDRESS" },
  );
  // A scheme.
  hop = await target("file:///etc/passwd");
  await assert.rejects(safeRequest(hop.url, common), { code: "BAD_URL" });
  // A loop.
  const loop = await serve((_req, res) => {
    res.writeHead(302, { location: "/again" });
    res.end();
  });
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${loop.port}/`, {
      ...common,
      maxRedirects: 3,
    }),
    { code: "TOO_MANY_REDIRECTS" },
  );
  assert.equal(loop.seen.length, 4);
});

test("a followed redirect to a safe hop works, and a 302 after POST becomes a bodyless GET", async () => {
  const { port, seen } = await serve((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final" });
      res.end();
    } else ok(res, "done");
  });
  const response = await safeRequest(`http://127.0.0.1:${port}/start`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
    allowLoopback: true,
    followRedirects: true,
  });
  assert.equal(response.text, "done");
  assert.deepEqual(
    seen.map(r => `${r.method} ${r.url}`),
    ["POST /start", "GET /final"],
  );
  assert.equal(seen[1].headers["content-type"], undefined);
});

test("planRedirect refuses an https to http hop while a credential is present", () => {
  const base = {
    from: new URL("https://api.example.com/a"),
    to: new URL("http://api.example.com/b"),
    status: 307,
    method: "POST",
    body: Buffer.from("x"),
    originalHost: "api.example.com",
    secretNames: new Set(["authorization", "x-api-key"]),
  };
  for (const name of ["authorization", "x-api-key"]) {
    assert.throws(() => planRedirect({ ...base, headers: { [name]: "v" } }), {
      code: "DOWNGRADE",
    });
  }
  // No credential: the downgrade goes through. http to https always does.
  assert.doesNotThrow(() =>
    planRedirect({ ...base, headers: { accept: "*/*" } }),
  );
  assert.doesNotThrow(() =>
    planRedirect({
      ...base,
      from: base.to,
      to: base.from,
      headers: { authorization: "v" },
    }),
  );
});

test("secret headers are dropped on a hop off the host, port or a subdomain, and stay dropped", async () => {
  const a = await serve((req, res) => {
    if (req.url === "/to-sub") {
      res.writeHead(302, { location: `http://sub.a.test:${a.port}/landing` });
      res.end();
    } else if (req.url === "/to-other") {
      res.writeHead(302, { location: `http://b.test:${a.port}/back` });
      res.end();
    } else if (req.url === "/back") {
      res.writeHead(302, { location: `http://a.test:${a.port}/landing` });
      res.end();
    } else if (req.url === "/to-port") {
      res.writeHead(302, { location: `http://a.test:${b.port}/landing` });
      res.end();
    } else if (req.url === "/same") {
      res.writeHead(302, { location: `http://a.test:${a.port}/landing` });
      res.end();
    } else ok(res);
  });
  const b = await serve((req, res) => ok(res));
  const resolve = resolverFor({
    "a.test": ["127.0.0.1"],
    "sub.a.test": ["127.0.0.1"],
    "b.test": ["127.0.0.1"],
  });
  const options = {
    headers: {
      Authorization: "Bearer T",
      "X-Custom-Key": "K",
      Accept: "text/plain",
    },
    secretHeaders: ["x-custom-key"],
    allowLoopback: true,
    followRedirects: true,
    resolve,
  };
  // The same host and port keeps them.
  await safeRequest(`http://a.test:${a.port}/same`, options);
  let landing = a.seen.at(-1);
  assert.equal(landing.url, "/landing");
  assert.equal(landing.headers.authorization, "Bearer T");
  assert.equal(landing.headers["x-custom-key"], "K");
  // A subdomain drops them.
  await safeRequest(`http://a.test:${a.port}/to-sub`, options);
  landing = a.seen.at(-1);
  assert.equal(landing.url, "/landing");
  assert.equal(landing.headers.authorization, undefined);
  assert.equal(landing.headers["x-custom-key"], undefined);
  // The same host on another port drops them.
  await safeRequest(`http://a.test:${a.port}/to-port`, options);
  assert.equal(b.seen.at(-1).headers.authorization, undefined);
  assert.equal(b.seen.at(-1).headers["x-custom-key"], undefined);
  // Another host drops them, and a hop back to the first host does not restore them.
  a.seen.length = 0;
  await safeRequest(`http://a.test:${a.port}/to-other`, options);
  assert.equal(a.seen[0].headers.authorization, "Bearer T");
  for (const hit of a.seen.slice(1)) {
    assert.equal(hit.headers.authorization, undefined, hit.url);
    assert.equal(hit.headers["x-custom-key"], undefined, hit.url);
    assert.equal(
      hit.headers.accept,
      "text/plain",
      "a header that is no secret stays",
    );
  }
  assert.equal(a.seen.at(-1).url, "/landing");
});

test("planRedirect keeps secrets only on the same host and port", () => {
  const base = {
    from: new URL("https://api.example.com/a"),
    status: 307,
    method: "POST",
    body: Buffer.from("x"),
    headers: { authorization: "v" },
    originalHost: "api.example.com",
    secretNames: new Set(["authorization"]),
  };
  const kept = to =>
    "authorization" in planRedirect({ ...base, to: new URL(to) }).headers;
  assert.equal(kept("https://api.example.com/b"), true);
  assert.equal(kept("https://api.example.com:8443/b"), false);
  assert.equal(kept("https://x.api.example.com/b"), false);
  assert.equal(kept("https://example.com/b"), false);
});

test("a stacked or unknown content-encoding is refused", async () => {
  for (const encoding of ["gzip, br", "zstd"]) {
    const { port } = await serve((req, res) => {
      res.writeHead(200, { "content-encoding": encoding });
      res.end("whatever");
    });
    await assert.rejects(
      safeRequest(`http://127.0.0.1:${port}/`, { allowLoopback: true }),
      { code: "BAD_ENCODING" },
      encoding,
    );
  }
});

test("a huge timeoutMs is clamped, not fired at once", async () => {
  const { port } = await serve((req, res) => ok(res, "fine"));
  const result = await safeRequest(`http://127.0.0.1:${port}/`, {
    allowLoopback: true,
    timeoutMs: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.text, "fine");
});

test("a resolver may answer with a string or one object", async () => {
  const { port } = await serve((req, res) => ok(res, "fine"));
  for (const answer of ["127.0.0.1", { address: "127.0.0.1", family: 4 }]) {
    const resolve = (_h, _o, callback) => callback(null, answer);
    const result = await safeRequest(`http://a.test:${port}/`, {
      allowLoopback: true,
      resolve,
    });
    assert.equal(result.text, "fine");
  }
});

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

test("the default cap is 100 MB", () => {
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 100 * 1024 * 1024);
});

test("a gzip bomb stops at the cap on decompressed bytes", async () => {
  // 64 MB of zeros gzips to about 64 KB.
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
  assert.ok(bomb.length < 1024 * 1024);
  const { port } = await serve((_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(bomb);
  });
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${port}/`, {
      allowLoopback: true,
      maxResponseBytes: 1024 * 1024,
    }),
    { code: "TOO_LARGE" },
  );
  // Under the cap it decodes.
  const small = await serve((_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(zlib.gzipSync("hello"));
  });
  const response = await safeRequest(`http://127.0.0.1:${small.port}/`, {
    allowLoopback: true,
  });
  assert.equal(response.text, "hello");
});

test("a declared or streamed body over the cap is refused", async () => {
  const declared = await serve((_req, res) => {
    res.writeHead(200, { "content-length": "5000" });
    res.end(Buffer.alloc(5000));
  });
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${declared.port}/`, {
      allowLoopback: true,
      maxResponseBytes: 1000,
    }),
    { code: "TOO_LARGE" },
  );
  const chunked = await serve((_req, res) => {
    res.writeHead(200);
    res.write(Buffer.alloc(800));
    res.end(Buffer.alloc(800));
  });
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${chunked.port}/`, {
      allowLoopback: true,
      maxResponseBytes: 1000,
    }),
    { code: "TOO_LARGE" },
  );
});

// ---------------------------------------------------------------------------
// Error redaction
// ---------------------------------------------------------------------------

test("errors carry no header value and no query string", async () => {
  const secrets = ["SECRET-TOKEN-VALUE", "SECRET-QUERY-VALUE", "SECRET-CUSTOM"];
  const headers = {
    Authorization: `Bearer ${secrets[0]}`,
    "X-Custom": secrets[2],
  };
  const query = `?api_key=${secrets[1]}`;
  const redirecting = await serve((_req, res) => {
    res.writeHead(302, { location: `http://169.254.169.254/x${query}` });
    res.end();
  });
  const big = await serve((_req, res) => {
    res.writeHead(200, { "content-length": "5000" });
    res.end(Buffer.alloc(5000));
  });
  const attempts = [
    () =>
      safeRequest(`http://rebind.test/p${query}`, {
        headers,
        resolve: resolverFor({ "rebind.test": ["10.0.0.1"] }),
      }),
    () => safeRequest(`http://169.254.169.254/p${query}`, { headers }),
    () =>
      safeRequest(`http://127.0.0.1:${redirecting.port}/p${query}`, {
        headers,
        allowLoopback: true,
        followRedirects: true,
      }),
    () =>
      safeRequest(`http://127.0.0.1:${big.port}/p${query}`, {
        headers,
        allowLoopback: true,
        maxResponseBytes: 10,
      }),
    () => safeRequest(`ftp://example.com/p${query}`, { headers }),
    () =>
      safeRequest(`http://user:${secrets[1]}@example.com/p${query}`, {
        headers,
      }),
  ];
  for (const attempt of attempts) {
    const error = await attempt().then(
      () => assert.fail("expected a refusal"),
      e => e,
    );
    assert.ok(error instanceof SafeRequestError);
    const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `${error.code} leaked ${secret}`);
  }
  // A downgrade refusal.
  try {
    planRedirect({
      from: new URL(`https://a.example.com/p${query}`),
      to: new URL(`http://a.example.com/q${query}`),
      status: 302,
      method: "GET",
      headers: { authorization: `Bearer ${secrets[0]}` },
      originalHost: "a.example.com",
      secretNames: new Set(["authorization"]),
    });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.equal(error.code, "DOWNGRADE");
    for (const secret of secrets) assert.ok(!error.message.includes(secret));
  }
});

test("the timeout covers the whole call", async () => {
  const { port } = await serve(() => {});
  await assert.rejects(
    safeRequest(`http://127.0.0.1:${port}/`, {
      allowLoopback: true,
      timeoutMs: 100,
    }),
    {
      name: "TimeoutError",
    },
  );
});
