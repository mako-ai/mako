/**
 * An axios instance with the SSRF guards of `safe-fetch.service.ts`, for
 * connectors whose target URL is user-supplied (REST, GraphQL).
 *
 * Those connectors used a plain `axios.create({ baseURL })`, so any workspace
 * member could point a connection at `http://169.254.169.254/…` or an
 * internal service and read the response back through a probe. This keeps
 * the axios API (callers, retries and `isAxiosError` handling are unchanged)
 * and enforces, on EVERY hop including redirects:
 *
 *   - http/https only, no `localhost` / `*.local` names;
 *   - IP-literal hosts must be public unicast (Node skips DNS for a literal,
 *     so these are checked before the request and in `beforeRedirect`);
 *   - DNS names are resolved by a guarded `lookup` on the socket agents, so
 *     the address actually connected to is the one validated (no rebinding
 *     window between check and connect);
 *   - no environment proxy (a proxy would make the lookup the proxy's);
 *   - metadata-only request headers stripped.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import axios, {
  type AxiosInstance,
  type CreateAxiosDefaults,
  type InternalAxiosRequestConfig,
} from "axios";
import {
  SafeFetchError,
  assertAllowedHostname,
  assertAllowedScheme,
  assertPublicIp,
  stripBlockedRequestHeaders,
} from "./safe-fetch.service";

type Resolver = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

const systemResolver: Resolver = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback);

/**
 * A socket `lookup` that refuses any non-public address. Exported with an
 * injectable resolver for tests.
 */
export function createSsrfSafeLookup(
  resolve: Resolver = systemResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    try {
      assertAllowedHostname(hostname);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, "", 0);
      return;
    }
    resolve(
      hostname,
      {
        family: options.family as number | undefined,
        hints: options.hints,
        all: true,
      },
      (err, addresses) => {
        if (err) {
          callback(err, "", 0);
          return;
        }
        if (!addresses || addresses.length === 0) {
          callback(
            new SafeFetchError(
              `DNS lookup returned no addresses for ${hostname}`,
            ) as NodeJS.ErrnoException,
            "",
            0,
          );
          return;
        }
        try {
          for (const entry of addresses) assertPublicIp(entry.address);
        } catch (error) {
          callback(error as NodeJS.ErrnoException, "", 0);
          return;
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
    );
  };
}

/** Scheme + hostname check for a URL about to be requested. */
export function assertSafeOutboundUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError(`Invalid URL: ${rawUrl}`);
  }
  assertAllowedScheme(url);
  assertAllowedHostname(url.hostname);
}

/**
 * follow-redirects `beforeRedirect` hook: re-validate the next hop (its
 * DNS name, if any, is then re-resolved by the guarded lookup) and keep the
 * metadata headers out of it too.
 */
export function assertSafeRedirect(options: {
  protocol?: string;
  hostname?: string;
  host?: string;
  headers?: Record<string, unknown>;
}): void {
  const protocol = options.protocol ?? "";
  if (protocol !== "http:" && protocol !== "https:") {
    throw new SafeFetchError(`Blocked redirect scheme: ${protocol}`);
  }
  const hostname = options.hostname ?? options.host ?? "";
  if (!hostname) throw new SafeFetchError("Redirect without a host");
  assertAllowedHostname(hostname);
  if (options.headers) {
    for (const name of Object.keys(options.headers)) {
      if (/^(metadata-flavor$|x-google-)/i.test(name)) {
        delete options.headers[name];
      }
    }
  }
}

let agents: { httpAgent: http.Agent; httpsAgent: https.Agent } | undefined;

function ssrfSafeAgents() {
  if (!agents) {
    const lookup = createSsrfSafeLookup();
    agents = {
      httpAgent: new http.Agent({ keepAlive: true, lookup }),
      httpsAgent: new https.Agent({ keepAlive: true, lookup }),
    };
  }
  return agents;
}

function stripHeaders(config: InternalAxiosRequestConfig): void {
  const headers = config.headers;
  if (!headers) return;
  const plain: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers.toJSON())) {
    if (typeof value === "string") plain[name] = value;
  }
  const kept = stripBlockedRequestHeaders(plain);
  for (const name of Object.keys(plain)) {
    if (!(name in kept)) headers.delete(name);
  }
}

/** `axios.create`, with the SSRF guards described at the top of this file. */
export function createSsrfSafeAxios(
  config: CreateAxiosDefaults = {},
): AxiosInstance {
  const { httpAgent, httpsAgent } = ssrfSafeAgents();
  const instance = axios.create({
    ...config,
    httpAgent,
    httpsAgent,
    proxy: false,
    beforeRedirect: options => assertSafeRedirect(options),
  });
  instance.interceptors.request.use(request => {
    // A per-request config cannot opt out of the guards.
    request.httpAgent = httpAgent;
    request.httpsAgent = httpsAgent;
    request.proxy = false;
    request.lookup = undefined;
    request.socketPath = undefined;
    request.beforeRedirect = options => assertSafeRedirect(options);
    assertSafeOutboundUrl(instance.getUri(request));
    stripHeaders(request);
    return request;
  });
  return instance;
}
