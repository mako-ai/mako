import { describe, it, expect } from "vitest";
import {
  mapPostgresOidToType,
  normalizePostgresFields,
  normalizePostgresRows,
  stripTrailingSqlSemicolon,
} from "./pg-type-utils";

describe("mapPostgresOidToType", () => {
  it("maps known OIDs to type names", () => {
    expect(mapPostgresOidToType(20)).toBe("BIGINT");
    expect(mapPostgresOidToType(701)).toBe("DOUBLE PRECISION");
    expect(mapPostgresOidToType(1043)).toBe("VARCHAR");
  });
});

describe("normalizePostgresFields", () => {
  it("annotates fields with their resolved type", () => {
    const fields = normalizePostgresFields([
      { name: "total_leads", dataTypeID: 20 },
      { name: "country", dataTypeID: 1043 },
    ]);

    expect(fields).toEqual([
      { name: "total_leads", dataTypeID: 20, type: "BIGINT" },
      { name: "country", dataTypeID: 1043, type: "VARCHAR" },
    ]);
  });
});

describe("normalizePostgresRows", () => {
  it("coerces in-range bigints to numbers and leaves overflow as strings", () => {
    const fields = normalizePostgresFields([
      { name: "total_leads", dataTypeID: 20 },
      { name: "country", dataTypeID: 1043 },
    ]);

    const rows = normalizePostgresRows(
      [
        { total_leads: "7401", country: "CH" },
        { total_leads: "9223372036854775807", country: "FR" },
      ],
      fields,
    );

    expect(rows[0]?.total_leads).toBe(7401);
    expect(rows[0]?.country).toBe("CH");
    expect(rows[1]?.total_leads).toBe("9223372036854775807");
  });
});

describe("stripTrailingSqlSemicolon", () => {
  it("removes a trailing semicolon and whitespace", () => {
    expect(stripTrailingSqlSemicolon("SELECT 1;\n")).toBe("SELECT 1");
    expect(stripTrailingSqlSemicolon("SELECT * FROM foo")).toBe(
      "SELECT * FROM foo",
    );
  });
});
