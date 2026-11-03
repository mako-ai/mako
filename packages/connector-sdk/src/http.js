/**
 * `ctx.http`: fetch with the three things every connector otherwise
 * reimplements badly — retry on the errors that are worth retrying, respect
 * for the vendor's own Retry-After, and a floor between requests.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How long to wait before attempt n+1.
 *
 * A vendor that tells us when to come back is obeyed: guessing shorter is how
 * a 429 becomes a rate-limit ban. Otherwise exponential with full jitter,
 * because synchronized retries from many flows are what turn one slow vendor
 * into a thundering herd.
 */
export function retryDelayMs(attempt, response, { baseMs = 500, maxMs = 60_000 } = {}) {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maxMs);
  }
  const ceiling = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.random() * ceiling;
}

export function isRetryable(response, error) {
  if (error) return true; // a transport failure: DNS, reset, timeout
  return RETRYABLE_STATUS.has(response.status);
}

export function createHttp({
  baseUrl,
  headers: defaultHeaders = {},
  maxRetries = 5,
  minIntervalMs = 0,
  timeoutMs = 60_000,
  log = () => {},
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  let lastRequestAt = 0;

  const resolveUrl = url => {
    if (!baseUrl) return url;
    if (/^https?:\/\//i.test(url)) return url;
    return `${baseUrl.replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
  };

  async function request(url, options = {}) {
    const target = resolveUrl(url);
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (minIntervalMs > 0) {
        const wait = lastRequestAt + minIntervalMs - Date.now();
        if (wait > 0) await sleepImpl(wait);
      }
      lastRequestAt = Date.now();

      let response;
      let error;
      // A per-attempt timeout, not a per-call one: a hung socket must not
      // consume the whole chunk's budget and take the retries down with it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchImpl(target, {
          ...options,
          signal: options.signal ?? controller.signal,
          headers: { ...defaultHeaders, ...(options.headers ?? {}) },
        });
      } catch (caught) {
        error = caught;
        lastError = caught;
      } finally {
        clearTimeout(timer);
      }

      if (response && response.ok) return response;
      if (attempt === maxRetries || !isRetryable(response, error)) {
        if (error) throw error;
        const body = await response.text().catch(() => "");
        throw new HttpError(response.status, target, body);
      }

      const delay = retryDelayMs(attempt, response);
      log(
        `${target} -> ${response ? response.status : String(error)}; retrying in ${Math.round(delay)}ms (${attempt + 1}/${maxRetries})`,
      );
      await sleepImpl(delay);
    }

    throw lastError ?? new Error(`Request to ${target} failed`);
  }

  const json = async (url, options) => (await request(url, options)).json();

  return {
    request,
    json,
    get: (url, options) => json(url, { ...options, method: "GET" }),
    post: (url, body, options) =>
      json(url, {
        ...options,
        method: "POST",
        headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

export class HttpError extends Error {
  constructor(status, url, body) {
    // The body is truncated into the message on purpose: a vendor's 400 says
    // WHY in the body, and a connector that only reports the status makes its
    // own failure unreadable in the flow log.
    super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 500)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}
