import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  explainCodexModelFailure,
  isUnsupportedCodexChatGptModel,
  pickSafeCodexModel,
} from "./codex-models";

describe("codex-models", () => {
  it("flags API/gateway sol models as unsupported for ChatGPT Codex", () => {
    assert.equal(isUnsupportedCodexChatGptModel("gpt-5.6-sol"), true);
    assert.equal(isUnsupportedCodexChatGptModel("openai/gpt-5.3-codex"), true);
    assert.equal(isUnsupportedCodexChatGptModel("gpt-5.1-codex"), false);
    assert.equal(isUnsupportedCodexChatGptModel("o3"), false);
  });

  it("replaces an unsupported current model with a safe advertised one", () => {
    const picked = pickSafeCodexModel(
      null,
      [
        { value: "gpt-5.6-sol", name: "Sol" },
        { value: "gpt-5.1-codex", name: "Codex" },
      ],
      "gpt-5.6-sol",
    );
    assert.equal(picked, "gpt-5.1-codex");
  });

  it("keeps a safe current model", () => {
    assert.equal(
      pickSafeCodexModel(null, [{ value: "gpt-5.1-codex", name: "Codex" }], "o3"),
      null,
    );
  });

  it("explains sol / Internal error failures", () => {
    assert.match(
      explainCodexModelFailure(
        "Model metadata for `gpt-5.6-sol` not found",
      ) || "",
      /ChatGPT/,
    );
    assert.match(explainCodexModelFailure("Internal error") || "", /codex-acp/);
  });
});
