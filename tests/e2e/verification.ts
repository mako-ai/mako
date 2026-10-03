import { MongoClient } from "mongodb";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Read the code, then submit it through the real UI; never mark a user verified. */
export async function registrationCode(email: string): Promise<string> {
  const codeFile = process.env.MAKO_E2E_VERIFICATION_FILE;
  if (codeFile) {
    // A mailbox reader can supply the real emailed code for a PR preview.
    // Match the fresh identity so a previous run's code can never be reused.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const record = JSON.parse(await readFile(codeFile, "utf8")) as {
          email: string;
          code: string;
        };
        if (record.email === email && /^\d{6}$/.test(record.code)) {
          return record.code;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await setTimeout(500);
    }
    throw new Error(
      "Timed out waiting for the fresh account's emailed verification code.",
    );
  }
  const uri = process.env.MAKO_E2E_MONGODB_URI;
  if (!uri) {
    throw new Error(
      "Set MAKO_E2E_MONGODB_URI to the local mako_e2e database used by the API.",
    );
  }
  const url = new URL(uri);
  if (
    url.protocol !== "mongodb:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/mako_e2e"
  ) {
    throw new Error(
      "Automatic OTP lookup is restricted to a loopback MongoDB database named mako_e2e.",
    );
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const record = await client
      .db()
      .collection("emailverifications")
      .findOne(
        {
          email: email.toLowerCase(),
          type: "registration",
          expiresAt: { $gt: new Date() },
        },
        { sort: { createdAt: -1 } },
      );
    if (!record || typeof record.code !== "string") {
      throw new Error(
        "No unexpired registration code found for the E2E account.",
      );
    }
    return record.code;
  } finally {
    await client.close();
  }
}
