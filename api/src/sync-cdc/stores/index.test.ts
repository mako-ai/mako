import { getCdcEventStoreConfig, resetCdcEventStoreForTests } from "./index";

describe("getCdcEventStoreConfig", () => {
  const originalPrimary = process.env.CDC_EVENT_STORE_PRIMARY;

  afterEach(() => {
    if (typeof originalPrimary === "undefined") {
      delete process.env.CDC_EVENT_STORE_PRIMARY;
    } else {
      process.env.CDC_EVENT_STORE_PRIMARY = originalPrimary;
    }

    resetCdcEventStoreForTests();
  });

  it("defaults to mongo store", () => {
    delete process.env.CDC_EVENT_STORE_PRIMARY;
    resetCdcEventStoreForTests();

    expect(getCdcEventStoreConfig()).toEqual({
      primary: "mongo",
    });
  });

  it("ignores unsupported primary values and falls back to mongo", () => {
    process.env.CDC_EVENT_STORE_PRIMARY = "warehouse";
    resetCdcEventStoreForTests();

    expect(getCdcEventStoreConfig()).toEqual({
      primary: "mongo",
    });
  });

  it("falls back to mongo for unknown values", () => {
    process.env.CDC_EVENT_STORE_PRIMARY = "unknown-store";
    resetCdcEventStoreForTests();

    expect(getCdcEventStoreConfig().primary).toBe("mongo");
  });
});
