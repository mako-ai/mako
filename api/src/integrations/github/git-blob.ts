/**
 * Compute the Git blob SHA-1 of a UTF-8 text file, matching what GitHub stores
 * as a blob's `sha`. Git hashes `blob <byteLength>\0<content>`. We use this to
 * detect working-tree modifications (current content SHA vs the SHA recorded
 * at the last import/sync) without round-tripping to the API.
 */
import { createHash } from "crypto";

export function gitBlobSha(content: string): string {
  const data = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${data.length}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, data]))
    .digest("hex");
}
