import { describe, it, expect } from "vitest";
import {
  isLocalBigQueryEmulator,
  bigQueryEmulatorEndpoint,
  bigQueryEmulatorHostPort,
} from "./bigquery-emulator";

describe("isLocalBigQueryEmulator", () => {
  it("treats localhost-family hosts as the emulator", () => {
    expect(isLocalBigQueryEmulator("http://localhost:9050")).toBe(true);
    expect(isLocalBigQueryEmulator("http://127.0.0.1:9050")).toBe(true);
    expect(isLocalBigQueryEmulator("http://0.0.0.0:9050")).toBe(true);
    expect(isLocalBigQueryEmulator("http://[::1]:9050")).toBe(true);
    // scheme-less host:port is tolerated
    expect(isLocalBigQueryEmulator("localhost:9050")).toBe(true);
  });

  it("never treats real GCP / remote hosts as the emulator", () => {
    expect(isLocalBigQueryEmulator("https://bigquery.googleapis.com")).toBe(
      false,
    );
    expect(isLocalBigQueryEmulator("https://my-proxy.internal.corp")).toBe(
      false,
    );
    expect(isLocalBigQueryEmulator(undefined)).toBe(false);
    expect(isLocalBigQueryEmulator("")).toBe(false);
    expect(isLocalBigQueryEmulator("not a url")).toBe(false);
  });
});

describe("bigQueryEmulatorEndpoint", () => {
  it("returns scheme://host[:port] without a path", () => {
    expect(bigQueryEmulatorEndpoint("http://localhost:9050")).toBe(
      "http://localhost:9050",
    );
    expect(bigQueryEmulatorEndpoint("http://localhost:9050/bigquery")).toBe(
      "http://localhost:9050",
    );
    expect(bigQueryEmulatorEndpoint("localhost:9050")).toBe(
      "http://localhost:9050",
    );
  });
});

describe("bigQueryEmulatorHostPort", () => {
  it("returns host:port for BIGQUERY_EMULATOR_HOST", () => {
    expect(bigQueryEmulatorHostPort("http://localhost:9050")).toBe(
      "localhost:9050",
    );
    expect(bigQueryEmulatorHostPort("127.0.0.1:9050")).toBe("127.0.0.1:9050");
  });
});
