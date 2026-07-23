import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  explainCodexModelFailure,
  isForeignGatewayCodexModel,
  isUnsupportedCodexChatGptModel,
  pickSafeCodexModel,
} from "./codex-models";

describe("codex-models", () => {
  it("allows GPT-5.6 Sol/Terra/Luna and flags only foreign gateway ids", () => {
    assert.equal(isForeignGatewayCodexModel("gpt-5.6-sol"), false);
    assert.equal(isForeignGatewayCodexModel("gpt-5.6-terra"), false);
    assert.equal(isForeignGatewayCodexModel("gpt-5.6-luna"), false);
    assert.equal(isForeignGatewayCodexModel("gpt-5.1-codex"), false);
    assert.equal(isForeignGatewayCodexModel("openai/gpt-5.3-codex"), true);
    assert.equal(isUnsupportedCodexChatGptModel("openai/foo"), true);
  });

  it("keeps gpt-5.6-sol as the current session model", () => {
    assert.equal(
      pickSafeCodexModel(
        null,
        [
          { value: "gpt-5.6-sol", name: "Sol" },
          { value: "gpt-5.6-terra", name: "Terra" },
        ],
        "gpt-5.6-sol",
      ),
      null,
    );
  });

  it("applies an explicit Sol/Terra pick", () => {
    assert.equal(
      pickSafeCodexModel(
        "gpt-5.6-terra",
        [{ value: "gpt-5.6-sol", name: "Sol" }],
        "gpt-5.6-sol",
      ),
      "gpt-5.6-terra",
    );
  });

  it("replaces a foreign gateway current model with Sol", () => {
    const picked = pickSafeCodexModel(
      null,
      [
        { value: "openai/gpt-5", name: "API" },
        { value: "gpt-5.6-sol", name: "Sol" },
      ],
      "openai/gpt-5",
    );
    assert.equal(picked, "gpt-5.6-sol");
  });

  it("explains metadata / Internal error with auto-update tips", () => {
    assert.match(
      explainCodexModelFailure(
        "Model metadata for `gpt-5.6-sol` not found",
      ) || "",
      /Mako will try to update|automatically/,
    );
    assert.match(
      explainCodexModelFailure("Internal error") || "",
      /Mako will try to update/,
    );
  });
});
