import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentModelFromConfigOptions,
  findModelConfigOption,
  modelChoicesFromConfigOptions,
  parseConfigOptions,
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
});
