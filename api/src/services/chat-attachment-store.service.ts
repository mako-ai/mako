import fs, { promises as fsPromises } from "fs";
import crypto from "crypto";
import path from "path";
import { Readable } from "stream";
import { Storage } from "@google-cloud/storage";
import { loggers } from "../logging";

export type ChatAttachmentStoreType = "filesystem" | "gcs" | "s3";

export interface ChatAttachmentMetadata {
  contentType: string;
  size: number | null;
}

export interface ChatAttachmentStore {
  readonly type: ChatAttachmentStoreType;
  putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string | null>;
  openReadStream(key: string): Promise<NodeJS.ReadableStream | null>;
  getMetadata(key: string): Promise<ChatAttachmentMetadata | null>;
  delete(key: string): Promise<void>;
}

const logger = loggers.api("chat-attachment-store");

function getStoreType(): ChatAttachmentStoreType {
  const raw =
    process.env.CHAT_ATTACHMENT_STORE || process.env.DASHBOARD_ARTIFACT_STORE;
  return raw === "gcs" || raw === "s3" ? raw : "filesystem";
}

function ensureSafeKey(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid chat attachment key: ${key}`);
  }
  return normalized;
}

function getFilesystemRoot(): string {
  if (process.env.CHAT_ATTACHMENT_DIR) {
    return process.env.CHAT_ATTACHMENT_DIR;
  }

  if (process.env.NODE_ENV === "production") {
    return "/data/chat-attachments";
  }

  return path.resolve(process.cwd(), ".data", "chat-attachments");
}

function metadataPath(filePath: string): string {
  return `${filePath}.meta.json`;
}

class FilesystemChatAttachmentStore implements ChatAttachmentStore {
  readonly type = "filesystem" as const;

  private resolvePath(key: string): string {
    return path.join(getFilesystemRoot(), ensureSafeKey(key));
  }

  async putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    const targetPath = this.resolvePath(key);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, body);
    await fsPromises.writeFile(
      metadataPath(targetPath),
      JSON.stringify({ contentType, metadata: metadata ?? {} }, null, 2),
      "utf8",
    );
    logger.info("Stored chat attachment in filesystem", {
      key,
      bytes: body.byteLength,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    try {
      return fs.createReadStream(this.resolvePath(key));
    } catch {
      return null;
    }
  }

  async getMetadata(key: string): Promise<ChatAttachmentMetadata | null> {
    try {
      const filePath = this.resolvePath(key);
      const [stat, rawMetadata] = await Promise.all([
        fsPromises.stat(filePath),
        fsPromises.readFile(metadataPath(filePath), "utf8").catch(() => null),
      ]);
      const parsed =
        rawMetadata != null
          ? (JSON.parse(rawMetadata) as { contentType?: string })
          : {};
      return {
        contentType: parsed.contentType || "application/octet-stream",
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const targetPath = this.resolvePath(key);
    await fsPromises.rm(targetPath, { force: true }).catch(() => undefined);
    await fsPromises
      .rm(metadataPath(targetPath), { force: true })
      .catch(() => undefined);
  }
}

class GcsChatAttachmentStore implements ChatAttachmentStore {
  readonly type = "gcs" as const;
  private readonly storage = new Storage();
  private readonly bucketName =
    process.env.GCS_CHAT_ATTACHMENTS_BUCKET ||
    process.env.GCS_DASHBOARD_BUCKET ||
    "";

  private file(key: string) {
    if (!this.bucketName) {
      throw new Error(
        "GCS_CHAT_ATTACHMENTS_BUCKET or GCS_DASHBOARD_BUCKET is required for gcs chat attachment store",
      );
    }
    return this.storage.bucket(this.bucketName).file(ensureSafeKey(key));
  }

  async putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const startedAt = Date.now();
    await this.file(key).save(body, {
      contentType,
      metadata: { metadata: metadata ?? {} },
      resumable: false,
    });
    logger.info("Stored chat attachment in GCS", {
      key,
      bytes: body.byteLength,
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

  async getMetadata(key: string): Promise<ChatAttachmentMetadata | null> {
    try {
      const [metadata] = await this.file(key).getMetadata();
      return {
        contentType: metadata.contentType || "application/octet-stream",
        size: metadata.size ? Number(metadata.size) : null,
      };
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

class S3ChatAttachmentStore implements ChatAttachmentStore {
  readonly type = "s3" as const;
  private readonly bucket =
    process.env.S3_CHAT_ATTACHMENTS_BUCKET ||
    process.env.S3_DASHBOARD_BUCKET ||
    "";
  private readonly region = process.env.S3_REGION || "us-east-1";
  private readonly endpoint =
    process.env.S3_ENDPOINT || "https://s3.amazonaws.com";
  private readonly accessKeyId = process.env.S3_ACCESS_KEY_ID || "";
  private readonly secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || "";
  private readonly sessionToken = process.env.S3_SESSION_TOKEN || "";
  private readonly forcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";

  private requireBucket(): string {
    if (!this.bucket) {
      throw new Error(
        "S3_CHAT_ATTACHMENTS_BUCKET or S3_DASHBOARD_BUCKET is required for s3 chat attachment store",
      );
    }
    return this.bucket;
  }

  private requireCredentials(): void {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for s3 chat attachment store",
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

  private async createSignedGetUrl(
    key: string,
    ttlSeconds: number,
  ): Promise<string> {
    this.requireCredentials();
    const { url, host, canonicalUri } = this.getObjectAddress(key);
    const now = new Date();
    const { amzDate, shortDate } = this.formatAmzDate(now);
    const credentialScope = `${shortDate}/${this.region}/s3/aws4_request`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(ttlSeconds),
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

  async putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const response = await this.signedRequest("PUT", key, {
      body,
      contentType,
    });
    if (!response.ok) {
      throw new Error(
        `S3 chat attachment PUT failed with ${response.status} ${response.statusText}`,
      );
    }
    logger.info("Stored chat attachment in S3", {
      key,
      bytes: body.byteLength,
      durationMs: Date.now() - startedAt,
      storeType: this.type,
    });
  }

  async getSignedUrl(key: string, ttlSeconds = 3600): Promise<string | null> {
    return await this.createSignedGetUrl(key, ttlSeconds);
  }

  async openReadStream(key: string): Promise<NodeJS.ReadableStream | null> {
    try {
      const url = await this.createSignedGetUrl(key, 3600);
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        return null;
      }
      return Readable.fromWeb(response.body);
    } catch {
      return null;
    }
  }

  async getMetadata(key: string): Promise<ChatAttachmentMetadata | null> {
    try {
      const response = await this.signedRequest("HEAD", key);
      if (!response.ok) {
        return null;
      }
      return {
        contentType:
          response.headers.get("content-type") || "application/octet-stream",
        size: Number(response.headers.get("content-length")) || null,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.signedRequest("DELETE", key).catch(() => undefined);
  }
}

let attachmentStore: ChatAttachmentStore | null = null;

export function getChatAttachmentStore(): ChatAttachmentStore {
  if (attachmentStore) {
    return attachmentStore;
  }

  switch (getStoreType()) {
    case "gcs":
      attachmentStore = new GcsChatAttachmentStore();
      break;
    case "s3":
      attachmentStore = new S3ChatAttachmentStore();
      break;
    default:
      attachmentStore = new FilesystemChatAttachmentStore();
      break;
  }

  return attachmentStore;
}

export function getChatAttachmentStoreType(): ChatAttachmentStoreType {
  return getChatAttachmentStore().type;
}

export function encodeAttachmentKey(key: string): string {
  return Buffer.from(ensureSafeKey(key), "utf8").toString("base64url");
}

export function decodeAttachmentKey(encoded: string): string | null {
  try {
    return ensureSafeKey(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function buildChatAttachmentKey(options: {
  workspaceId: string;
  chatId: string;
  filename?: string;
  mediaType: string;
}): string {
  const configuredPrefix =
    process.env.CHAT_ATTACHMENT_PREFIX || "chat-attachments";
  const prefix = ensureSafeKey(configuredPrefix);
  const extension = extensionForMediaType(options.mediaType, options.filename);
  return [
    prefix,
    options.workspaceId,
    options.chatId,
    `${crypto.randomUUID()}${extension}`,
  ].join("/");
}

function extensionForMediaType(mediaType: string, filename?: string): string {
  const filenameExtension = filename ? path.extname(filename).toLowerCase() : "";
  if (/^\.[a-z0-9]+$/i.test(filenameExtension)) {
    return filenameExtension;
  }

  switch (mediaType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

export async function readAttachmentAsDataUrl(
  key: string,
  mediaType: string,
): Promise<string | null> {
  const stream = await getChatAttachmentStore().openReadStream(key);
  if (!stream) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return `data:${mediaType};base64,${Buffer.concat(chunks).toString("base64")}`;
}
