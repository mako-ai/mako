/**
 * `safeRequest`: one outbound HTTP request for a connector whose target URL
 * a user typed in (GraphQL, REST). A box sits outside Mako's network, but a
 * workspace can still point a connection at a cloud metadata service or an
 * internal host. This is the one place that refuses it.
 *
 *  - The host name is resolved ONCE, by the socket's own `lookup`. Every
 *    resolved address is checked against an allowlist (public unicast, and
 *    loopback only when the caller opts in) and the socket connects to the
 *    address that was checked. There is no separate check lookup, so DNS
 *    rebinding (a public answer first, 169.254.169.254 next) has no window.
 *  - IP literals skip DNS in Node, so they are checked on every hop.
 *  - Redirects are returned to the caller, or followed when asked. Each hop
 *    is checked again. An https to http hop is refused while a credential is
 *    on the request. Secret headers are dropped on a hop that leaves the
 *    original host and its subdomains.
 *  - The decompressed body is capped (100 MB by default).
 *  - Errors name the origin and path. They carry no header value and no
 *    query string.
 *
 * It uses node:http and node:https, not fetch: fetch takes no `lookup`
 * without undici. No agent is shared and no environment proxy is read.
 */

import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";

export const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_REDIRECTS = 5;

/** Header names that always count as credentials. */
const DEFAULT_SECRET_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
];

/** An error `safeRequest` raises itself. `code` says which rule fired. */
export class SafeRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafeRequestError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

/** IPv4 ranges that are not public unicast. Loopback (127/8) is handled apart. */
const V4_BLOCKED = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function v4Value(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some(n => !(n >= 0 && n <= 255))) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

const inRange = (value, base, bits) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (value & mask) === (v4Value(base) & mask);
};

function v4Blocked(host, allowLoopback) {
  const value = v4Value(host);
  if (value === null) return true;
  if (inRange(value, "127.0.0.0", 8)) return !allowLoopback;
  return V4_BLOCKED.some(([base, bits]) => inRange(value, base, bits));
}

/** An IPv6 address's 8 groups, `::` expanded; null when it is not one. */
function v6Groups(address) {
  // A dotted IPv4 tail (`::ffff:169.254.169.254`) is the last two groups.
  const host = address.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_, a, b, c, d) =>
      `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`,
  );
  const [head, tail, ...rest] = host.split("::");
  if (rest.length > 0) return null;
  const parse = part => (part ? part.split(":").map(g => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  if (tail === undefined && left.length !== 8) return null;
  const groups = [
    ...left,
    ...new Array(Math.max(0, 8 - left.length - right.length)).fill(0),
    ...right,
  ];
  return groups.length === 8 &&
    groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const v4Text = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");

function v6Blocked(address, allowLoopback) {
  const g = v6Groups(address);
  if (!g) return true;
  const zero = (from, to) => g.slice(from, to).every(x => x === 0);
  if (zero(0, 7) && g[7] === 1) return !allowLoopback; // ::1
  // ::ffff:a.b.c.d is judged as the IPv4 address it reaches.
  if (zero(0, 5) && g[5] === 0xffff)
    return v4Blocked(v4Text(g[6], g[7]), allowLoopback);
  // Only global unicast 2000::/3 is left. This drops ::, IPv4-compatible,
  // 64:ff9b::/96, 64:ff9b:1::/48, ::ffff:0:0:0/96 (SIIT), 100::/64,
  // fc00::/7, fe80::/10, fec0::/10 and multicast.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  // 2001::/23 (protocol assignments, Teredo, ORCHID), 2001:db8::/32 and
  // 3fff::/20 (documentation).
  if (g[0] === 0x2001 && (g[1] < 0x200 || g[1] === 0xdb8)) return true;
  if (g[0] === 0x3fff && g[1] < 0x1000) return true;
  // 6to4 carries an IPv4 address in bits 16-47. It must be public.
  if (g[0] === 0x2002) return v4Blocked(v4Text(g[1], g[2]), false);
  return false;
}

/**
 * True when `address` is not an address a connector may connect to: only
 * public unicast passes, plus loopback when `allowLoopback` is set. Anything
 * that does not parse is blocked. Pass the canonical text a resolver or
 * `new URL(...).hostname` gives, so decimal, octal and hex IPv4 literals
 * arrive as dotted quads.
 */
export function isBlockedAddress(address, { allowLoopback = false } = {}) {
  const host = String(address)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host.includes(":")
    ? v6Blocked(host, allowLoopback)
    : v4Blocked(host, allowLoopback);
}

/** Cloud metadata names, with or without a trailing dot. */
function isMetadataName(host) {
  const name = host.toLowerCase().replace(/\.+$/, "");
  return (
    name === "metadata" ||
    name === "metadata.google.internal" ||
    name.endsWith(".internal")
  );
}

// ---------------------------------------------------------------------------
// Guarded lookup
// ---------------------------------------------------------------------------

const systemResolver = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback);

/**
 * A socket `lookup` that refuses a name when ANY address it resolves to is
 * blocked, and otherwise returns the addresses it checked. `resolve` is
 * injectable for tests.
 */
export function createGuardedLookup({
  allowLoopback = false,
  resolve = systemResolver,
} = {}) {
  return (hostname, options, callback) => {
    resolve(
      hostname,
      { family: options?.family, hints: options?.hints, all: true },
      (err, addresses) => {
        if (err) return callback(err, "", 0);
        if (!addresses || addresses.length === 0) {
          return callback(
            Object.assign(new Error(`No address for ${hostname}`), {
              code: "ENOTFOUND",
            }),
            "",
            0,
          );
        }
        const bad = addresses.find(a =>
          isBlockedAddress(a.address, { allowLoopback }),
        );
        if (bad) {
          return callback(
            new SafeRequestError(
              "BLOCKED_ADDRESS",
              `${hostname} resolves to a blocked address: ${bad.address}`,
            ),
            "",
            0,
          );
        }
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    );
  };
}

// ---------------------------------------------------------------------------
// URL checks
// ---------------------------------------------------------------------------

/** `origin/path` of a URL, with no userinfo, query or fragment. */
function describe(url) {
  try {
    const u = url instanceof URL ? url : new URL(url);
    return `${u.origin === "null" ? u.protocol : u.origin}${u.pathname}`;
  } catch {
    return "the URL";
  }
}

/**
 * Check a URL before connecting: http or https, no credentials in it, no
 * metadata name, no blocked IP literal. A host name is checked by the
 * socket's lookup, as Node skips the lookup for a literal. Returns the URL.
 */
export function checkUrl(input, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new SafeRequestError("BAD_URL", "Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeRequestError(
      "BAD_URL",
      `The URL must be http or https: ${describe(url)}`,
    );
  }
  if (url.username || url.password) {
    throw new SafeRequestError(
      "BAD_URL",
      `The URL must not carry credentials: ${describe(url)}`,
    );
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (
    isMetadataName(host) ||
    (isIP(host) && isBlockedAddress(host, { allowLoopback }))
  ) {
    throw new SafeRequestError(
      "BLOCKED_HOST",
      `The URL points at a private or metadata address: ${host}`,
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const hostOf = url =>
  url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");

/** The same host, or a subdomain of it. */
function sameOrSubdomain(host, original) {
  return host === original || host.endsWith(`.${original}`);
}

/**
 * @param {string | URL} input
 * @param {object} [options]
 * @param {string} [options.method]            default POST when a body is given, else GET
 * @param {Record<string, unknown>} [options.headers]
 * @param {string | Uint8Array} [options.body]
 * @param {number} [options.timeoutMs]         the whole call, redirects included
 * @param {boolean} [options.allowLoopback]    loopback reaches only the box
 * @param {boolean} [options.followRedirects]  default false: a 3xx is returned
 * @param {number} [options.maxRedirects]
 * @param {string[]} [options.secretHeaders]   names dropped on a hop off the original host
 * @param {number} [options.maxResponseBytes]  cap on the decompressed body
 * @param {Function} [options.resolve]         a `dns.lookup`-shaped resolver, for tests
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string, url: string }>}
 */
export async function safeRequest(input, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowLoopback = false,
    followRedirects = false,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    resolve,
  } = options;
  const secretNames = new Set([
    ...DEFAULT_SECRET_HEADERS,
    ...(options.secretHeaders ?? []).map(n => String(n).toLowerCase()),
  ]);

  let url = checkUrl(input, { allowLoopback });
  const originalHost = hostOf(url);
  let method = (
    options.method ?? (options.body === undefined ? "GET" : "POST")
  ).toUpperCase();
  let body = options.body === undefined ? undefined : Buffer.from(options.body);
  let headers = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined && value !== null)
      headers[name.toLowerCase()] = String(value);
  }
  if (!("accept-encoding" in headers))
    headers["accept-encoding"] = "gzip, deflate, br";

  // One deadline for the call. `abort` ends whichever hop is in flight.
  let abort = () => {};
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);

  try {
    for (let hop = 0; ; hop++) {
      const response = await sendOnce(
        url,
        { method, headers, body, allowLoopback, maxResponseBytes, resolve },
        fn => {
          abort = fn;
        },
      ).catch(error => {
        if (timedOut && !(error instanceof SafeRequestError)) {
          const timeout = new Error(
            `The request to ${describe(url)} timed out after ${timeoutMs} ms`,
          );
          timeout.name = "TimeoutError";
          timeout.code = "ETIMEDOUT";
          throw timeout;
        }
        throw error;
      });

      const location = response.headers.location;
      if (
        !followRedirects ||
        !REDIRECT_STATUS.has(response.status) ||
        !location
      ) {
        return {
          status: response.status,
          headers: response.headers,
          text: response.text,
          url: url.toString(),
        };
      }
      if (hop >= maxRedirects) {
        throw new SafeRequestError(
          "TOO_MANY_REDIRECTS",
          `More than ${maxRedirects} redirects from ${describe(url)}`,
        );
      }

      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new SafeRequestError(
          "BAD_URL",
          `${describe(url)} redirected to an invalid URL`,
        );
      }
      // The next hop passes every check the first one did.
      try {
        next = checkUrl(next, { allowLoopback });
      } catch (error) {
        if (error instanceof SafeRequestError) {
          throw new SafeRequestError(
            error.code,
            `Redirect from ${describe(url)} refused: ${error.message}`,
          );
        }
        throw error;
      }
      ({ method, body, headers } = planRedirect({
        from: url,
        to: next,
        status: response.status,
        method,
        body,
        headers,
        originalHost,
        secretNames,
      }));
      url = next;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the next hop sends. Refuses an https to http hop while a credential
 * is on the request. Drops the secret headers when the hop leaves the
 * original host and its subdomains, and keeps them dropped. 303, and 301 or
 * 302 after a POST, become a bodyless GET, as in fetch.
 */
export function planRedirect({
  from,
  to,
  status,
  method,
  body,
  headers,
  originalHost,
  secretNames,
}) {
  const secrets =
    secretNames instanceof Set ? secretNames : new Set(secretNames);
  const carriesSecret = Object.entries(headers).some(
    ([name, value]) => secrets.has(name) && value !== "",
  );
  if (from.protocol === "https:" && to.protocol === "http:" && carriesSecret) {
    throw new SafeRequestError(
      "DOWNGRADE",
      `Redirect from ${describe(from)} to ${describe(to)} refused: https to http with credentials`,
    );
  }
  let next = { ...headers };
  if (!sameOrSubdomain(hostOf(to), originalHost)) {
    next = Object.fromEntries(
      Object.entries(next).filter(([name]) => !secrets.has(name)),
    );
  }
  if (
    status === 303 ||
    ((status === 301 || status === 302) && method === "POST")
  ) {
    delete next["content-type"];
    delete next["content-length"];
    delete next["transfer-encoding"];
    return {
      method: method === "HEAD" ? "HEAD" : "GET",
      body: undefined,
      headers: next,
    };
  }
  return { method, body, headers: next };
}

/** One hop: no redirects, no retries. */
function sendOnce(
  url,
  { method, headers, body, allowLoopback, maxResponseBytes, resolve },
  setAbort,
) {
  return new Promise((done, fail) => {
    const transport = url.protocol === "https:" ? https : http;
    const outgoing = { ...headers };
    if (body) outgoing["content-length"] = String(body.length);
    let req;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    try {
      req = transport.request(url, {
        method,
        agent: false,
        lookup: createGuardedLookup({ allowLoopback, resolve }),
        headers: outgoing,
      });
    } catch (error) {
      // Node names the header, never its value, in this message.
      finish(fail, error);
      return;
    }
    setAbort(() => req.destroy(new Error("aborted")));

    req.on("error", error => finish(fail, error));
    req.on("response", res => {
      const declared = Number(res.headers["content-length"]);
      const encoding = String(res.headers["content-encoding"] ?? "")
        .trim()
        .toLowerCase();
      if (
        !encoding &&
        Number.isFinite(declared) &&
        declared > maxResponseBytes
      ) {
        res.destroy();
        return finish(fail, tooLarge(url, maxResponseBytes));
      }
      const decoder =
        encoding === "gzip" || encoding === "x-gzip"
          ? zlib.createGunzip()
          : encoding === "deflate"
            ? zlib.createInflate()
            : encoding === "br"
              ? zlib.createBrotliDecompress()
              : null;
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks = [];
      let size = 0;
      const stop = error => {
        res.destroy();
        decoder?.destroy();
        finish(fail, error);
      };
      res.on("error", error => finish(fail, error));
      stream.on("error", error => finish(fail, error));
      // The cap counts decompressed bytes, so a gzip bomb stops here.
      stream.on("data", chunk => {
        size += chunk.length;
        if (size > maxResponseBytes)
          return stop(tooLarge(url, maxResponseBytes));
        chunks.push(chunk);
      });
      stream.on("end", () => {
        const headersOut = {};
        for (const [name, value] of Object.entries(res.headers)) {
          headersOut[name] = Array.isArray(value)
            ? value.join(", ")
            : String(value ?? "");
        }
        finish(done, {
          status: res.statusCode ?? 0,
          headers: headersOut,
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      setAbort(() => stop(new Error("aborted")));
    });
    req.end(body);
  });
}

const tooLarge = (url, max) =>
  new SafeRequestError(
    "TOO_LARGE",
    `The response from ${describe(url)} is larger than ${max} bytes`,
  );
