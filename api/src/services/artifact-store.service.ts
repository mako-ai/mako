/**
 * The object store for materialized artifacts: app binding parquet, app
 * deployment bundles, dbt outputs and chat attachments.
 *
 * The configuration names are historical (this store was first built for the
 * since-removed dashboards) and are kept so existing deployments keep
 * working: DASHBOARD_ARTIFACT_STORE (filesystem | gcs | s3),
 * DASHBOARD_ARTIFACT_DIR, DASHBOARD_ARTIFACT_PREFIX and GCS_DASHBOARD_BUCKET,
 * plus the `/data/dashboard-artifacts` / `.data/dashboard-artifacts`
 * filesystem roots and the `dashboard-artifacts/...` key prefixes, which
 * address data that already exists.
 */
import { promises as fsPromises } from "fs";
import crypto from "crypto";
import path from "path";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { loggers } from "../logging";

export type ArtifactStoreType = "filesystem" | "gcs" | "s3";

export interface ArtifactStore {
  readonly type: ArtifactStoreType;
  exists(key: string): Promise<boolean>;
  put(
    localPath: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  /**
   * Store an in-memory buffer at `key` with an explicit content type. Used for
   * non-Parquet artifacts (e.g. chat image attachments) where the bytes never
   * touch a temp file on disk.
   */
  putBuffer(
    buffer: Buffer | Uint8Array,
    key: string,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string | null>;
  openReadStream(key: string): Promise<NodeJS.ReadableStream | null>;
  getSize(key: string): Promise<number | null>;
  /**
   * Open the object and learn its size in ONE round trip: null when it is
   * missing, a throw for any other failure. Serving a published app's assets
   * used to cost exists() + exists() + getMetadata() before the first byte —
   * three sequential GCS calls per file. The stream is held until the store
   * has answered, so a missing object is a clean null (→ 404), never a 200
   * that aborts mid-body. Absent on stores that cannot do better than the
   * probes; callers fall back to exists/openReadStream/getSize.
   */
  openRead?(
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number | null } | null>;
  /**
   * When the object at `key` was last written, or null when it is missing
   * or the store cannot say. Publish uses it to tell a content-addressed
   * binding artifact that is merely PRESENT from one that is also CURRENT,
   * so it must reflect the last CONTENT write (a metadata-only update, such
   * as a storage-class transition, must not count) and must not throw — a
   * null is "unknown", which the caller treats as stale.
   */
  getLastModified(key: string): Promise<Date | null>;
  delete(key: string): Promise<void>;
  /**
   * Make sure a browser can fetch this store's signed URLs directly: the
   * request that follows a cross-origin redirect carries an Origin header,
   * and without a CORS rule on the bucket the browser downloads the bytes
   * and then refuses to hand them to the page. Returns true once the bucket
   * verifiably has such a rule (installing it if missing and permitted).
   * Absent on stores that cannot check (filesystem, S3) — callers treat
   * that as "not safe to redirect".
   */
  ensureBrowserCors?(): Promise<boolean>;
  /**
   * `gs://bucket/object` for this key. DuckDB httpfs reads this URI when
   * chat-with-app skips the local copy (`APP_CHAT_PARQUET_DIRECT_GCS`).
   * Absent on filesystem/S3 stores.
   */
  gcsObjectUri?(key: string): string | null;
  /**
   * Short-lived OAuth access token from this store's GCS client (ADC /
   * service account). Used as DuckDB
   * `CREATE SECRET (TYPE gcs, BEARER_TOKEN …)` when HMAC keys are unset.
   */
  getOauthAccessToken?(): Promise<string | null>;
}

const logger = loggers.api("artifact-store");

function getStoreType(): ArtifactStoreType {
  const raw = process.env.DASHBOARD_ARTIFACT_STORE;
  return raw === "gcs" || raw === "s3" ? raw : "filesystem";
}

function ensureSafeKey(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid artifact key: ${key}`);
  }
  return normalized;
}

/** A GCS `timeCreated` / S3 `Last-Modified` value as a Date, or null if unusable. */
function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getFilesystemRoot(): string {
  if (process.env.DASHBOARD_ARTIFACT_DIR) {
    return process.env.DASHBOARD_ARTIFACT_DIR;
  }

  if (process.env.NODE_ENV === "production") {
    return "/data/dashboard-artifacts";
  }

  return path.resolve(process.cwd(), ".data", "dashboard-artifacts");
}

class FilesystemArtifactStore implements ArtifactStore {
  readonly type = "filesystem" as const;

  private resolvePath(key: string): string {
    return path.join(getFilesystemRoot(), ensureSafeKey(key));
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    const startedAt = Date.now();
    try {
      const stat = await fsPromises.stat(filePath);
      logger.debug("Checked filesystem artifact existence", {
        key,
        exists: stat.isFile(),
        durationMs: Date.now() - startedAt,
        storeType: this.type,
      });
      return stat.isFile();
    } catch {
      logger.debug("Filesystem artifact missing", {
        key,
        exists: false,
        durationMs: Date.now() - startedAt,
        storeType: this.type,
      });
      return false;
    }
  }

  async put(
    localPath: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    const targetPath = this.resolvePath(key);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.copyFile(localPath, targetPath);
    if (metadata && Object.keys(metadata).length > 0) {
      await fsPromises.writeFile(
        `${targetPath}.meta.json`,
        JSON.stringify(metadata, null, 2),
        "utf8",
      );
    }
    const stat = await fsPromises.stat(targetPath);
    logger.info("Stored artifact in filesystem", {
      key,
      bytes: stat.size,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async putBuffer(
    buffer: Buffer | Uint8Array,
    key: string,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    const targetPath = this.resolvePath(key);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, buffer);
    await fsPromises.writeFile(
      `${targetPath}.meta.json`,
      JSON.stringify({ contentType, ...(metadata || {}) }, null, 2),
      "utf8",
    );
    logger.info("Stored buffer artifact in filesystem", {
      key,
      bytes: buffer.byteLength,
      contentType,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    // fs.createReadStream on a missing file only errors ASYNCHRONOUSLY —
    // after the serve route has already sent 200 headers — which truncates
    // direct responses and permanently hangs proxied ones (the Vite dev
    // proxy never terminates the client request). Open the fd first so a
    // missing artifact is a clean `null` (routes turn it into a 404).
    try {
      const handle = await fsPromises.open(this.resolvePath(key), "r");
      return handle.createReadStream();
    } catch {
      return null;
    }
  }

  async getSize(key: string): Promise<number | null> {
    try {
      const stat = await fsPromises.stat(this.resolvePath(key));
      return stat.size;
    } catch {
      return null;
    }
  }

  async openRead(
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number | null } | null> {
    let handle: Awaited<ReturnType<typeof fsPromises.open>>;
    try {
      handle = await fsPromises.open(this.resolvePath(key), "r");
    } catch {
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return null;
      }
      return { stream: handle.createReadStream(), size: stat.size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async getLastModified(key: string): Promise<Date | null> {
    try {
      const stat = await fsPromises.stat(this.resolvePath(key));
      return stat.mtime;
    } catch (error) {
      logger.debug("Could not read filesystem artifact write time", {
        key,
        storeType: this.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const targetPath = this.resolvePath(key);
    await fsPromises.rm(targetPath, { force: true }).catch(() => undefined);
    await fsPromises
      .rm(`${targetPath}.meta.json`, { force: true })
      .catch(() => undefined);
  }
}

/**
 * Start a GCS media download and wait for its response headers.
 *
 * `File.createReadStream()` sends nothing until someone reads, and reports a
 * missing object only as an error event after that. `read(0)` starts the
 * request without consuming a byte; the body then buffers in the stream until
 * the HTTP response pipes it on. A 404 resolves null; any other failure
 * rejects, as the exists() probe this replaces did.
 */
export async function openGcsRead(
  stream: NodeJS.ReadableStream & {
    destroy(error?: Error): unknown;
    read(size?: number): unknown;
  },
): Promise<{ stream: NodeJS.ReadableStream; size: number | null } | null> {
  // Errors after the handover belong to whoever pipes the stream (it sees
  // them too). This listener only stops one landing in the gap from crashing
  // the process as an unhandled 'error' event.
  stream.on("error", () => undefined);
  return await new Promise((resolve, reject) => {
    const done = () => {
      stream.removeListener("response", onResponse);
      stream.removeListener("error", onError);
    };
    const onResponse = (res: {
      statusCode?: number;
      headers?: Record<string, string | string[] | undefined>;
    }) => {
      // A failure status: the library destroys the stream with the error
      // next, and onError classifies it (404 → null).
      if ((res.statusCode ?? 0) >= 400) return;
      done();
      const header = (name: string) => {
        const value = res.headers?.[name];
        return Array.isArray(value) ? value[0] : value;
      };
      // GCS may answer gzip and the library decompresses: then the wire
      // length is not the body length, so send no Content-Length at all.
      const encoded = (header("content-encoding") ?? "identity") !== "identity";
      const length = Number(header("content-length"));
      resolve({
        stream,
        size:
          !encoded && header("content-length") !== undefined && length >= 0
            ? length
            : null,
      });
    };
    const onError = (error: Error & { code?: number | string }) => {
      done();
      if (Number(error.code) === 404) resolve(null);
      else reject(error);
    };
    stream.on("response", onResponse);
    stream.on("error", onError);
    stream.read(0);
  });
}

class GcsArtifactStore implements ArtifactStore {
  readonly type = "gcs" as const;
  private readonly storage = new Storage();
  private readonly bucketName: string;

  constructor(bucketName?: string) {
    this.bucketName = bucketName || process.env.GCS_DASHBOARD_BUCKET || "";
  }

  private file(key: string) {
    if (!this.bucketName) {
      throw new Error(
        "GCS_DASHBOARD_BUCKET is required for gcs artifact store",
      );
    }
    return this.storage.bucket(this.bucketName).file(ensureSafeKey(key));
  }

  async exists(key: string): Promise<boolean> {
    const startedAt = Date.now();
    const [exists] = await this.file(key).exists();
    logger.debug("Checked GCS artifact existence", {
      key,
      exists,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
    return exists;
  }

  async put(
    localPath: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    await this.storage.bucket(this.bucketName).upload(localPath, {
      destination: ensureSafeKey(key),
      metadata: {
        contentType: "application/vnd.apache.parquet",
        metadata,
      },
      resumable: false,
    });
    const [metadataResult] = await this.file(key).getMetadata();
    logger.info("Stored artifact in GCS", {
      key,
      bytes: Number(metadataResult.size || 0),
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async putBuffer(
    buffer: Buffer | Uint8Array,
    key: string,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    await this.file(key).save(Buffer.from(buffer), {
      contentType,
      resumable: false,
      metadata: metadata ? { metadata } : undefined,
    });
    logger.info("Stored buffer artifact in GCS", {
      key,
      bytes: buffer.byteLength,
      contentType,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async getSignedUrl(key: string, ttlSeconds = 3600): Promise<string | null> {
    const [signedUrl] = await this.file(key).getSignedUrl({
      action: "read",
      expires: Date.now() + ttlSeconds * 1000,
    });
    return signedUrl;
  }

  gcsObjectUri(key: string): string | null {
    if (!this.bucketName) return null;
    return `gs://${this.bucketName}/${ensureSafeKey(key)}`;
  }

  async getOauthAccessToken(): Promise<string | null> {
    try {
      // Read-only scope so a DuckDB secret cannot COPY/overwrite parquet
      // even though the runtime SA may have objectAdmin for uploads.
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
      });
      const token = await auth.getAccessToken();
      return token || null;
    } catch (error) {
      logger.warn("Could not mint a GCS OAuth token for DuckDB", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Origin "*" on purpose: a V4 signed URL is itself the credential (anyone
   * holding it can fetch for its TTL, from any origin), so restricting CORS
   * origins here would protect nothing while breaking every dev host —
   * localhost:5173, a laptop running an app's vite dev, preview URLs. The
   * headers cover what parquet readers use: length/range for footer reads.
   */
  async ensureBrowserCors(): Promise<boolean> {
    const bucket = this.storage.bucket(this.bucketName);
    if (!this.bucketName) return false;
    const [metadata] = await bucket.getMetadata();
    const rules = metadata.cors ?? [];
    const satisfied = rules.some(
      rule =>
        (rule.origin ?? []).includes("*") &&
        (rule.method ?? []).includes("GET"),
    );
    if (satisfied) return true;
    await bucket.setMetadata({
      cors: [
        ...rules,
        {
          origin: ["*"],
          method: ["GET", "HEAD"],
          responseHeader: [
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "ETag",
            "Last-Modified",
          ],
          maxAgeSeconds: 3600,
        },
      ],
    });
    logger.info("Installed browser CORS rule on artifact bucket", {
      bucket: this.bucketName,
    });
    return true;
  }

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    // Same lazy-error hazard as the filesystem store: a GCS read stream for a
    // missing object only fails after headers are sent. Probe existence first
    // so callers get `null` (→ 404) instead of a mid-stream abort.
    try {
      const file = this.file(key);
      const [exists] = await file.exists();
      if (!exists) return null;
      return file.createReadStream();
    } catch {
      return null;
    }
  }

  async getSize(key: string): Promise<number | null> {
    try {
      const [metadata] = await this.file(key).getMetadata();
      return metadata.size ? Number(metadata.size) : null;
    } catch {
      return null;
    }
  }

  async openRead(
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number | null } | null> {
    return await openGcsRead(this.file(key).createReadStream());
  }

  async getLastModified(key: string): Promise<Date | null> {
    try {
      const [metadata] = await this.file(key).getMetadata();
      // `timeCreated` is the current generation's creation time — every
      // content write creates a new generation — whereas `updated` also
      // moves on metadata-only changes (lifecycle storage-class transitions,
      // custom-metadata patches), which would make a day-old artifact look
      // freshly built.
      return parseTimestamp(metadata.timeCreated ?? metadata.updated);
    } catch (error) {
      logger.warn("Could not read GCS artifact write time", {
        key,
        storeType: this.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.file(key)
      .delete({ ignoreNotFound: true })
      .catch(() => undefined);
  }
}

class S3ArtifactStore implements ArtifactStore {
  readonly type = "s3" as const;
  private readonly bucket = process.env.S3_DASHBOARD_BUCKET || "";
  private readonly region = process.env.S3_REGION || "us-east-1";
  private readonly endpoint =
    process.env.S3_ENDPOINT || "https://s3.amazonaws.com";
  private readonly accessKeyId = process.env.S3_ACCESS_KEY_ID || "";
  private readonly secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || "";
  private readonly sessionToken = process.env.S3_SESSION_TOKEN || "";
  private readonly forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  private requireBucket(): string {
    if (!this.bucket) {
      throw new Error("S3_DASHBOARD_BUCKET is required for s3 artifact store");
    }
    return this.bucket;
  }

  private requireCredentials(): void {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for s3 artifact store",
      );
    }
  }

  private sha256Hex(value: string | Uint8Array): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private hmac(key: Buffer | string, value: string): Buffer {
    return crypto.createHmac("sha256", key).update(value).digest();
  }

  private getSigningKey(shortDate: string): Buffer {
    const kDate = this.hmac(`AWS4${this.secretAccessKey}`, shortDate);
    const kRegion = this.hmac(kDate, this.region);
    const kService = this.hmac(kRegion, "s3");
    return this.hmac(kService, "aws4_request");
  }

  private formatAmzDate(now: Date): { amzDate: string; shortDate: string } {
    const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return {
      amzDate: iso,
      shortDate: iso.slice(0, 8),
    };
  }

  private getObjectAddress(key: string): {
    url: URL;
    host: string;
    canonicalUri: string;
  } {
    const safeKey = ensureSafeKey(key);
    const endpoint = new URL(this.endpoint);
    const normalizedPath = safeKey
      .split("/")
      .map(segment => encodeURIComponent(segment))
      .join("/");

    if (this.forcePathStyle) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(this.requireBucket())}/${normalizedPath}`;
      return {
        url: endpoint,
        host: endpoint.host,
        canonicalUri: endpoint.pathname,
      };
    }

    endpoint.hostname = `${this.requireBucket()}.${endpoint.hostname}`;
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${normalizedPath}`;
    return {
      url: endpoint,
      host: endpoint.host,
      canonicalUri: endpoint.pathname,
    };
  }

  private buildCanonicalQuery(params: URLSearchParams): string {
    return Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&");
  }

  private buildSignedHeaders(extraHeaders: Record<string, string>) {
    const normalized = Object.entries(extraHeaders)
      .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const canonicalHeaders = normalized
      .map(([key, value]) => `${key}:${value}\n`)
      .join("");
    const signedHeaders = normalized.map(([key]) => key).join(";");
    return { canonicalHeaders, signedHeaders };
  }

  private async signedRequest(
    method: "HEAD" | "PUT" | "DELETE",
    key: string,
    options?: { body?: Uint8Array; contentType?: string },
  ): Promise<Response> {
    this.requireCredentials();
    const { url, host, canonicalUri } = this.getObjectAddress(key);
    const now = new Date();
    const { amzDate, shortDate } = this.formatAmzDate(now);
    const payloadHash =
      method === "HEAD" || method === "DELETE"
        ? "UNSIGNED-PAYLOAD"
        : this.sha256Hex(options?.body || new Uint8Array());
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (options?.contentType) {
      headers["content-type"] = options.contentType;
    }
    if (this.sessionToken) {
      headers["x-amz-security-token"] = this.sessionToken;
    }
    const { canonicalHeaders, signedHeaders } =
      this.buildSignedHeaders(headers);
    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = crypto
      .createHmac("sha256", this.getSigningKey(shortDate))
      .update(stringToSign)
      .digest("hex");

    const requestHeaders = new Headers();
    for (const [keyName, value] of Object.entries(headers)) {
      requestHeaders.set(keyName, value);
    }
    requestHeaders.set(
      "Authorization",
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );

    return await fetch(url, {
      method,
      headers: requestHeaders,
      body: options?.body ? Buffer.from(options.body) : undefined,
    });
  }

  private async createSignedGetUrl(key: string): Promise<string> {
    this.requireCredentials();
    const { url, host, canonicalUri } = this.getObjectAddress(key);
    const now = new Date();
    const { amzDate, shortDate } = this.formatAmzDate(now);
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": "3600",
      "X-Amz-SignedHeaders": "host",
    });
    if (this.sessionToken) {
      params.set("X-Amz-Security-Token", this.sessionToken);
    }
    const canonicalQuery = this.buildCanonicalQuery(params);
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQuery,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = crypto
      .createHmac("sha256", this.getSigningKey(shortDate))
      .update(stringToSign)
      .digest("hex");
    params.set("X-Amz-Signature", signature);
    url.search = params.toString();
    return url.toString();
  }

  async exists(key: string): Promise<boolean> {
    try {
      const startedAt = Date.now();
      const response = await this.signedRequest("HEAD", key);
      logger.debug("Checked S3 artifact existence", {
        key,
        exists: response.ok,
        durationMs: Date.now() - startedAt,
        storeType: this.type,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async put(
    localPath: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    const body = await fsPromises.readFile(localPath);
    const response = await this.signedRequest("PUT", key, {
      body,
      contentType: "application/vnd.apache.parquet",
    });
    if (!response.ok) {
      throw new Error(
        `S3 PUT failed with ${response.status} ${response.statusText}`,
      );
    }
    logger.info("Stored artifact in S3", {
      key,
      bytes: body.byteLength,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
    void metadata;
  }

  async putBuffer(
    buffer: Buffer | Uint8Array,
    key: string,
    contentType: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const body = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const response = await this.signedRequest("PUT", key, {
      body,
      contentType,
    });
    if (!response.ok) {
      throw new Error(
        `S3 PUT failed with ${response.status} ${response.statusText}`,
      );
    }
    logger.info("Stored buffer artifact in S3", {
      key,
      bytes: body.byteLength,
      contentType,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async getSignedUrl(key: string): Promise<string | null> {
    return await this.createSignedGetUrl(key);
  }

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    try {
      const url = await this.createSignedGetUrl(key);
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        return null;
      }
      const { Readable } = await import("stream");
      return Readable.fromWeb(response.body as any);
    } catch {
      return null;
    }
  }

  async getSize(key: string): Promise<number | null> {
    try {
      const response = await this.signedRequest("HEAD", key);
      return response.ok
        ? Number(response.headers.get("content-length")) || null
        : null;
    } catch {
      return null;
    }
  }

  async getLastModified(key: string): Promise<Date | null> {
    try {
      const response = await this.signedRequest("HEAD", key);
      if (!response.ok) {
        logger.warn("Could not read S3 artifact write time", {
          key,
          storeType: this.type,
          status: response.status,
        });
        return null;
      }
      return parseTimestamp(response.headers.get("last-modified"));
    } catch (error) {
      logger.warn("Could not read S3 artifact write time", {
        key,
        storeType: this.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.signedRequest("DELETE", key).catch(() => undefined);
  }
}

let artifactStore: ArtifactStore | null = null;

export function getArtifactStore(): ArtifactStore {
  if (artifactStore) {
    return artifactStore;
  }

  switch (getStoreType()) {
    case "gcs":
      artifactStore = new GcsArtifactStore();
      break;
    case "s3":
      artifactStore = new S3ArtifactStore();
      break;
    default:
      artifactStore = new FilesystemArtifactStore();
      break;
  }

  return artifactStore;
}

/**
 * A read-only artifact store for existing app artifacts, distinct from the
 * live store written TO. Set APPS_ARTIFACT_SOURCE_BUCKET to a GCS bucket when
 * a rehearsal environment uses a cloned production database but an isolated
 * writable artifact store. Published deployment reads may fall back to this
 * source; writes always stay in the live store. Unset (prod and normal runs)
 * returns null, and callers use the main store exactly as before.
 */
export function getArtifactSourceStore(): ArtifactStore | null {
  const bucket = process.env.APPS_ARTIFACT_SOURCE_BUCKET; // pre-rename name
  if (!bucket) return null;
  return new GcsArtifactStore(bucket);
}

export function getFilesystemArtifactPath(key: string): string {
  return path.join(getFilesystemRoot(), ensureSafeKey(key));
}

export function getArtifactStoreType(): ArtifactStoreType {
  return getArtifactStore().type;
}

/**
 * Object-store key prefix for all materialized artifacts (app bindings and
 * deployments share the same bucket/prefix). The defaults are historical and
 * address existing objects — do not rename them.
 */
export function getArtifactPrefix(): string {
  const rawPrefix = process.env.DASHBOARD_ARTIFACT_PREFIX;
  if (rawPrefix) {
    return rawPrefix.replace(/^\/+|\/+$/g, "");
  }

  if (process.env.PR_NUMBER) {
    return `dashboard-artifacts/pr-${process.env.PR_NUMBER}`;
  }

  if (process.env.NODE_ENV === "production") {
    return "dashboard-artifacts/prod";
  }

  return "dashboards";
}

export async function storeArtifact(
  localPath: string,
  key: string,
  metadata?: Record<string, string>,
): Promise<void> {
  await getArtifactStore().put(localPath, key, metadata);
}
