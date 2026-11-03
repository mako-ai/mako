/**
 * How an `app_browse` result reaches the model.
 *
 * Lives in its own module so the mapping can be unit-tested without pulling in
 * the sandbox/git/storage service graph that `apps-tools.ts` initializes at
 * import time.
 *
 * Two rules, both learned the hard way:
 *
 * 1. The screenshot must ride as an IMAGE part, not as base64 prose. As text
 *    it is ~25k tokens of noise the model cannot see through; as media it is
 *    actual eyes.
 *
 * 2. The part must be a `file` with an `image/*` media type. Tool output
 *    used to offer `image-data` and `file-data` (AI SDK 7 folds both into
 *    `file`), and a file whose media type is not an image means *document*.
 *    Every provider honors that distinction, and each one fails differently
 *    when you get it wrong:
 *      - OpenAI maps file-data to `input_file`/`file_data`, which rejects
 *        image MIME types with a 400 that kills the entire turn.
 *      - Anthropic maps only `application/pdf` and silently DROPS anything
 *        else — the screenshot never arrived and nothing said so.
 *    An `image/jpeg` file becomes `input_image` / an Anthropic image block.
 *    `browse-model-output.test.ts` pins this.
 */

export interface BrowseModelOutputResult {
  screenshotBase64?: string;
  [key: string]: unknown;
}

export type BrowseModelOutput =
  | { type: "json"; value: Record<string, unknown> }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | {
            type: "file";
            mediaType: string;
            data: { type: "data"; data: string };
          }
      >;
    };

/**
 * @param supportsVision Resolved model accepts image input. `undefined` means
 *   unknown (external MCP clients) and is treated as yes.
 */
export function buildBrowseModelOutput(
  output: unknown,
  supportsVision: boolean | undefined,
): BrowseModelOutput {
  const result = output as BrowseModelOutputResult | null | undefined;
  if (!result || typeof result !== "object") {
    return { type: "json", value: (result ?? null) as never };
  }

  // A text-only model receiving an image part loses the whole result (§13.26):
  // vision-less models get text (pageText + screenshotUrl) only.
  if (supportsVision === false) {
    const { screenshotBase64: _omitted, ...rest } = result;
    return { type: "json", value: rest };
  }

  if (!result.screenshotBase64) {
    return { type: "json", value: result };
  }

  const { screenshotBase64, ...rest } = result;
  return {
    type: "content",
    value: [
      { type: "text", text: JSON.stringify(rest) },
      {
        type: "file",
        mediaType: "image/jpeg",
        data: { type: "data", data: screenshotBase64 },
      },
    ],
  };
}
