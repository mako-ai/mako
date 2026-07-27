import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  explainCodexModelFailure,
  isChatGptRejectedCodexModel,
  isCodexChatGptModelRejectedError,
  isForeignGatewayCodexModel,
  isUnsupportedCodexChatGptModel,
  pickChatGptCompatibleCodexModel,
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

  it("treats Sol as ChatGPT-rejected and prefers Terra", () => {
    assert.equal(isChatGptRejectedCodexModel("gpt-5.6-sol"), true);
    assert.equal(isChatGptRejectedCodexModel("gpt-5.6-terra"), false);
    assert.equal(
      pickChatGptCompatibleCodexModel([
        { value: "gpt-5.6-sol", name: "Sol" },
        { value: "gpt-5.6-terra", name: "Terra" },
      ]),
      "gpt-5.6-terra",
    );
  });

  it("switches adapter default Sol to Terra for ChatGPT-safe sessions", () => {
    assert.equal(
      pickSafeCodexModel(
        null,
        [
          { value: "gpt-5.6-sol", name: "Sol" },
          { value: "gpt-5.6-terra", name: "Terra" },
        ],
        "gpt-5.6-sol",
      ),
      "gpt-5.6-terra",
    );
  });

  it("remaps an explicit Sol pick to Terra for ChatGPT accounts", () => {
    assert.equal(
      pickSafeCodexModel(
        "gpt-5.6-sol",
        [
          { value: "gpt-5.6-sol", name: "Sol" },
          { value: "gpt-5.6-terra", name: "Terra" },
        ],
        "gpt-5.6-terra",
      ),
      "gpt-5.6-terra",
    );
  });

  it("applies an explicit Terra pick", () => {
    assert.equal(
      pickSafeCodexModel(
        "gpt-5.6-terra",
        [{ value: "gpt-5.6-sol", name: "Sol" }],
        "gpt-5.6-sol",
      ),
      "gpt-5.6-terra",
    );
  });

  it("replaces a foreign gateway current model with Terra", () => {
    const picked = pickSafeCodexModel(
      null,
      [
        { value: "openai/gpt-5", name: "API" },
        { value: "gpt-5.6-sol", name: "Sol" },
        { value: "gpt-5.6-terra", name: "Terra" },
      ],
      "openai/gpt-5",
    );
    assert.equal(picked, "gpt-5.6-terra");
  });

  it("explains ChatGPT model rejection / metadata / API key / Internal error", () => {
    assert.equal(
      isCodexChatGptModelRejectedError(
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      ),
      true,
    );
    assert.match(
      explainCodexModelFailure(
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      ) || "",
      /Terra|ChatGPT subscription/,
    );
    assert.match(
      explainCodexModelFailure(
        "Model metadata for `gpt-5.6-sol` not found",
      ) || "",
      /Terra|automatically/,
    );
    assert.match(
      explainCodexModelFailure(
        "Internal error: CODEX_API_KEY or OPENAI_API_KEY is not set",
      ) || "",
      /codex login|Sign in with ChatGPT/,
    );
    assert.match(
      explainCodexModelFailure("Internal error") || "",
      /codex login|Sign in|outdated/,
    );
  });
});
