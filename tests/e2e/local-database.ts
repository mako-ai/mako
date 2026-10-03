import { MongoClient } from "mongodb";

/** Fixtures and OTP lookup may never touch a shared or production database. */
export function localTestDatabase(): MongoClient {
  const uri = process.env.MAKO_E2E_MONGODB_URI;
  if (!uri)
    throw new Error("Set MAKO_E2E_MONGODB_URI to the local mako_e2e database.");
  const url = new URL(uri);
  if (
    url.protocol !== "mongodb:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/mako_e2e"
  ) {
    throw new Error(
      "E2E database access is restricted to loopback MongoDB named mako_e2e.",
    );
  }
  return new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
}
