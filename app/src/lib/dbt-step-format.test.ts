import { describe, expect, it } from "vitest";
import { formatRowsAffected, formatStepDuration } from "./dbt-step-format";

describe("formatRowsAffected", () => {
  it("shows a real count, including zero", () => {
    expect(formatRowsAffected(1250)).toBe("1250");
    expect(formatRowsAffected(0)).toBe("0");
  });

  it("blanks dbt's -1 sentinel for 'not applicable'", () => {
    // Postgres/Redshift report rows_affected -1 for CREATE VIEW and other
    // statements with no meaningful row count. Rendering "-1" reads as a bug.
    expect(formatRowsAffected(-1)).toBe("");
  });

  it("blanks any other negative, and a missing value", () => {
    expect(formatRowsAffected(-42)).toBe("");
    expect(formatRowsAffected(undefined)).toBe("");
  });
});

describe("formatStepDuration", () => {
  it("renders seconds to two decimals", () => {
    expect(formatStepDuration(1900)).toBe("1.90s");
    expect(formatStepDuration(60)).toBe("0.06s");
    expect(formatStepDuration(0)).toBe("0.00s");
  });
});
