import { describe, it, expect } from "vitest";
import { interpretCloudSaveResponse } from "./connection-save";

describe("interpretCloudSaveResponse", () => {
  it("marks a verified save as saved+verified", () => {
    const outcome = interpretCloudSaveResponse({
      success: true,
      verified: true,
      data: { _id: "abc" },
    });
    expect(outcome).toEqual({
      outcome: "saved",
      verified: true,
      data: { _id: "abc" },
    });
  });

  it("treats a successful but unverified save (Save anyways) as not activated", () => {
    const outcome = interpretCloudSaveResponse({
      success: true,
      verified: false,
      data: { _id: "xyz" },
    });
    expect(outcome.outcome).toBe("saved");
    if (outcome.outcome === "saved") {
      expect(outcome.verified).toBe(false);
    }
  });

  it("defaults verified to false when the API omits it", () => {
    const outcome = interpretCloudSaveResponse({ success: true });
    expect(outcome).toMatchObject({ outcome: "saved", verified: false });
  });

  it("routes a failed pre-save connection test to the test_failed outcome", () => {
    const outcome = interpretCloudSaveResponse({
      success: false,
      code: "connection_test_failed",
      error: "ECONNREFUSED",
    });
    expect(outcome).toEqual({
      outcome: "test_failed",
      error: "ECONNREFUSED",
    });
  });

  it("routes other failures to a plain error outcome", () => {
    const outcome = interpretCloudSaveResponse({
      success: false,
      error: "Workspace database limit reached",
    });
    expect(outcome).toEqual({
      outcome: "error",
      error: "Workspace database limit reached",
    });
  });
});
