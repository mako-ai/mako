import { describe, expect, it } from "vitest";

import { createStderrClassifier } from "./runner.service";

describe("createStderrClassifier", () => {
  it("labels a Python warning and its indented source line as warn", () => {
    const classify = createStderrClassifier();
    const lines = [
      "/opt/dbt/lib/python3.11/site-packages/google/api_core/_python_version_support.py:266: FutureWarning: You are using a Python version (3.11.2) which Google will stop supporting in new releases of google.api_core once it reaches its end of life (2027-10-04).",
      "  warnings.warn(message, FutureWarning)",
    ];
    expect(lines.map(classify)).toEqual(["warn", "warn"]);
  });

  it("keeps tracebacks and other stderr output as error", () => {
    const classify = createStderrClassifier();
    expect(classify("/x/mod.py:3: DeprecationWarning: old api")).toBe("warn");
    expect(classify("Traceback (most recent call last):")).toBe("error");
    expect(classify('  File "/x/y.py", line 1, in <module>')).toBe("error");
    expect(classify("RuntimeError: boom")).toBe("error");
  });
});
