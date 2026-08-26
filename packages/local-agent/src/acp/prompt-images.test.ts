import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  parsePromptImages,
} from "./prompt-images";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("parsePromptImages", () => {
  it("returns [] for undefined/null/empty", () => {
    assert.deepEqual(parsePromptImages(undefined), []);
    assert.deepEqual(parsePromptImages(null), []);
    assert.deepEqual(parsePromptImages([]), []);
  });

  it("accepts valid base64 images and preserves uri", () => {
    const images = parsePromptImages([
      { data: PNG_BASE64, mimeType: "image/png" },
      { data: PNG_BASE64, mimeType: "image/jpeg", uri: "file:///shot.jpg" },
    ]);
    assert.equal(images.length, 2);
    assert.equal(images[0].mimeType, "image/png");
    assert.equal(images[0].uri, undefined);
    assert.equal(images[1].uri, "file:///shot.jpg");
  });

  it("strips whitespace from base64 payloads", () => {
    const chunked = `${PNG_BASE64.slice(0, 20)}\n${PNG_BASE64.slice(20)}`;
    const images = parsePromptImages([
      { data: chunked, mimeType: "image/png" },
    ]);
    assert.equal(images[0].data, PNG_BASE64);
  });

  it("rejects non-array input", () => {
    assert.throws(() => parsePromptImages({}), /must be an array/);
  });

  it("rejects non-image mime types", () => {
    assert.throws(
      () => parsePromptImages([{ data: PNG_BASE64, mimeType: "text/plain" }]),
      /Only image attachments/,
    );
  });

  it("rejects data: URL payloads (must be raw base64)", () => {
    assert.throws(
      () =>
        parsePromptImages([
          {
            data: `data:image/png;base64,${PNG_BASE64}`,
            mimeType: "image/png",
          },
        ]),
      /base64/,
    );
  });

  it("rejects missing or empty data", () => {
    assert.throws(
      () => parsePromptImages([{ mimeType: "image/png" }]),
      /missing base64 data/,
    );
    assert.throws(
      () => parsePromptImages([{ data: "   ", mimeType: "image/png" }]),
      /missing base64 data/,
    );
  });

  it("rejects too many images", () => {
    const many = Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => ({
      data: PNG_BASE64,
      mimeType: "image/png",
    }));
    assert.throws(() => parsePromptImages(many), /Too many image attachments/);
  });

  it("rejects oversized images", () => {
    // Base64 string large enough to decode past the per-image cap.
    const hugeLen = Math.ceil((MAX_PROMPT_IMAGE_BYTES * 4) / 3) + 8;
    const huge = "A".repeat(hugeLen);
    assert.throws(
      () => parsePromptImages([{ data: huge, mimeType: "image/png" }]),
      /too large/,
    );
  });
});
