import { localTestDatabase } from "./local-database";

/** Read the code, then submit it through the real UI; never mark a user verified. */
export async function registrationCode(email: string): Promise<string> {
  const client = localTestDatabase();
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
