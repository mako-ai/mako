import { describe, expect, it } from "vitest";
import type { FileUIPart } from "ai";
import { fileUiPartsToAcpImages } from "./local-acp-images";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function filePart(url: string, mediaType = "image/png"): FileUIPart {
  return { type: "file", url, mediaType };
}

describe("fileUiPartsToAcpImages", () => {
  it("returns empty for no files", () => {
    expect(fileUiPartsToAcpImages(undefined)).toEqual({
      images: [],
      skipped: 0,
    });
    expect(fileUiPartsToAcpImages([])).toEqual({ images: [], skipped: 0 });
  });

  it("converts base64 data URLs to ACP image payloads", () => {
    const { images, skipped } = fileUiPartsToAcpImages([
      filePart(`data:image/png;base64,${PNG_BASE64}`),
    ]);
    expect(skipped).toBe(0);
    expect(images).toEqual([{ data: PNG_BASE64, mimeType: "image/png" }]);
  });

  it("uses the data URL mime when mediaType is missing", () => {
    const part = {
      type: "file",
      url: `data:image/jpeg;base64,${PNG_BASE64}`,
    } as FileUIPart;
    const { images } = fileUiPartsToAcpImages([part]);
    expect(images[0]?.mimeType).toBe("image/jpeg");
  });

  it("skips remote URLs and non-image media", () => {
    const { images, skipped } = fileUiPartsToAcpImages([
      filePart("https://example.com/shot.png"),
      filePart(`data:application/pdf;base64,${PNG_BASE64}`, "application/pdf"),
      filePart(`data:image/png;base64,${PNG_BASE64}`),
    ]);
    expect(images).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("skips data URLs without base64 payloads", () => {
    const { images, skipped } = fileUiPartsToAcpImages([
      filePart("data:image/svg+xml,<svg/>", "image/svg+xml"),
    ]);
    expect(images).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});
