import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentModelFromConfigOptions,
  findModelConfigOption,
  modelChoicesFromConfigOptions,
  parseConfigOptions,
  resolveModelConfigValue,
} from "./session-config";

describe("session-config", () => {
  it("parses model select options including groups", () => {
    const options = parseConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [
          { value: "sonnet", name: "Sonnet" },
          {
            group: "premium",
            name: "Premium",
            options: [{ value: "fable", name: "Fable" }],
          },
        ],
      },
    ]);
    assert.equal(findModelConfigOption(options)?.id, "model");
    assert.deepEqual(
      modelChoicesFromConfigOptions(options).map(m => m.value),
      ["sonnet", "fable"],
    );
    assert.equal(currentModelFromConfigOptions(options), "sonnet");
  });

  it("resolves short Claude aliases to advertised canonical ids", () => {
    const available = [
      { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { value: "claude-fable-5", name: "Claude Fable 5" },
    ];
    assert.equal(resolveModelConfigValue("opus", available), "claude-opus-4-6");
    assert.equal(
      resolveModelConfigValue("sonnet", available),
      "claude-sonnet-4-5",
    );
    assert.equal(resolveModelConfigValue("fable", available), "claude-fable-5");
    assert.equal(
      resolveModelConfigValue("claude-opus-4-6", available),
      "claude-opus-4-6",
    );
    assert.equal(resolveModelConfigValue("opus", []), "claude-opus-4-6");
    assert.equal(resolveModelConfigValue("fable", []), "claude-fable-5");
  });
});
