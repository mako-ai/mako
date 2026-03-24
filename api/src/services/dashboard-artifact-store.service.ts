import fs, { promises as fsPromises } from "fs";
import crypto from "crypto";
import path from "path";
import { Storage } from "@google-cloud/storage";
import { loggers } from "../logging";

export type DashboardArtifactStoreType = "filesystem" | "gcs" | "s3";

export interface DashboardArtifactStore {
  readonly type: DashboardArtifactStoreType;
  exists(key: string): Promise<boolean>;
  put(
    localPath: string,
    key: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string | null>;
  openReadStream(key: string): Promise<NodeJS.ReadableStream | null>;
  getSize(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

const logger = loggers.api("dashboard-artifact-store");

function getStoreType(): DashboardArtifactStoreType {
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

function getFilesystemRoot(): string {
  if (process.env.DASHBOARD_ARTIFACT_DIR) {
    return process.env.DASHBOARD_ARTIFACT_DIR;
  }

  if (process.env.NODE_ENV === "production") {
    return "/data/dashboard-artifacts";
  }

  return path.resolve(process.cwd(), ".data", "dashboard-artifacts");
}

class FilesystemDashboardArtifactStore implements DashboardArtifactStore {
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
    logger.info("Stored dashboard artifact in filesystem", {
      key,
      bytes: stat.size,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    return fs.createReadStream(this.resolvePath(key));
  }

  async getSize(key: string): Promise<number | null> {
    try {
      const stat = await fsPromises.stat(this.resolvePath(key));
      return stat.size;
    } catch {
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

class GcsDashboardArtifactStore implements DashboardArtifactStore {
  readonly type = "gcs" as const;
  private readonly storage = new Storage();
  private readonly bucketName = process.env.GCS_DASHBOARD_BUCKET || "";

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
    logger.info("Stored dashboard artifact in GCS", {
      key,
      bytes: Number(metadataResult.size || 0),
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

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    try {
      return this.file(key).createReadStream();
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

  async delete(key: string): Promise<void> {
    await this.file(key)
      .delete({ ignoreNotFound: true })
      .catch(() => undefined);
  }
}

class S3DashboardArtifactStore implements DashboardArtifactStore {
  readonly type = "s3" as const;
  private readonly bucket = process.env.S3_DASHBOARD_BUCKET || "";
  private readonly region = process.env.S3_REGION || "us-east-1";
  private readonly endpoint =
    process.env.S3_ENDPOINT || "https://s3.amazonaws.com";
  private readonly accessKeyId = process.env.S3_ACCESS_KEY_ID || "";
  private readonly secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || "";
  private readonly sessionToken = process.env.S3_SESSION_TOKEN || "";
  private readonly forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";
  private readonly publicBaseUrl = process.env.S3_PUBLIC_BASE_URL || "";

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
    logger.info("Stored dashboard artifact in S3", {
      key,
      bytes: body.byteLength,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
    void metadata;
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

  async delete(key: string): Promise<void> {
    await this.signedRequest("DELETE", key).catch(() => undefined);
  }
}

let artifactStore: DashboardArtifactStore | null = null;

export function getDashboardArtifactStore(): DashboardArtifactStore {
  if (artifactStore) {
    return artifactStore;
  }

  switch (getStoreType()) {
    case "gcs":
      artifactStore = new GcsDashboardArtifactStore();
      break;
    case "s3":
      artifactStore = new S3DashboardArtifactStore();
      break;
    default:
      artifactStore = new FilesystemDashboardArtifactStore();
      break;
  }

  return artifactStore;
}

export function getFilesystemArtifactPath(key: string): string {
  return path.join(getFilesystemRoot(), ensureSafeKey(key));
}

export function getDashboardArtifactStoreType(): DashboardArtifactStoreType {
  return getDashboardArtifactStore().type;
}
