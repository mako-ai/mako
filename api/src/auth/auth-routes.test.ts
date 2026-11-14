/**
 * Email/password auth routes: the brute-force limits (per IP from trusted
 * hops only, and per account regardless of IP) and the error contract (a
 * user-facing AuthError keeps its message; anything else is a generic 500,
 * and a failed verification email never fails register).
 */
import bcrypt from "bcrypt";
import { Hono } from "hono";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EmailVerification, Session, User } from "../database/schema";
import { emailService } from "../services/email.service";
import { resetRateLimitForTests } from "../middleware/rate-limit";
import { authRoutes } from "./auth.controller";

let mongo: MongoMemoryServer;
const app = new Hono().route("/api/auth", authRoutes);

beforeAll(async () => {
  delete process.env.REDIS_URL;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  vi.restoreAllMocks();
  resetRateLimitForTests();
  await Promise.all([
    User.deleteMany({}),
    EmailVerification.deleteMany({}),
    Session.deleteMany({}),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

let ipCounter = 0;
const randomIp = () => `198.51.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createUser(email: string, password: string, verified = true) {
  await User.create({
    _id: `u${Math.random().toString(36).slice(2, 12)}`,
    email,
    hashedPassword: await bcrypt.hash(password, 4),
    emailVerified: verified,
  });
}

it("a forged x-forwarded-for per request no longer buys a fresh IP bucket", async () => {
  // In production the proxy APPENDS the real address, so a client's forged
  // value is everything to its left. Rotating that prefix must not help.
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await post(
      "/forgot-password",
      { email: `nobody${i}@example.com` },
      { "x-forwarded-for": `${randomIp()}, 203.0.113.9` },
    );
    statuses.push(res.status);
  }
  expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
  expect(statuses[5]).toBe(429);
});

it("rotating IPs cannot brute-force a reset code: 5 wrong guesses, then 429", async () => {
  await createUser("victim@example.com", "correct-horse-battery");
  await EmailVerification.create({
    email: "victim@example.com",
    code: "123456",
    type: "password_reset",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await post(
      "/reset-password",
      {
        email: "victim@example.com",
        code: String(200000 + i),
        password: "new-password-123",
      },
      // A brand-new address every time, as far as any header can tell.
      { "x-forwarded-for": randomIp(), "cf-connecting-ip": randomIp() },
    );
    statuses.push(res.status);
  }
  expect(statuses).toEqual([400, 400, 400, 400, 400]);

  // The 6th attempt is refused even with the RIGHT code and a new IP, and
  // the budget is shared with /verify-email (same "code" bucket).
  const sixth = await post(
    "/reset-password",
    {
      email: "VICTIM@example.com",
      code: "123456",
      password: "new-password-123",
    },
    { "x-forwarded-for": randomIp(), "cf-connecting-ip": randomIp() },
  );
  expect(sixth.status).toBe(429);
  const verify = await post(
    "/verify-email",
    { email: "victim@example.com", code: "654321" },
    { "cf-connecting-ip": randomIp() },
  );
  expect(verify.status).toBe(429);
});

it("password guesses for one account are capped whatever the IP; success clears the budget", async () => {
  await createUser("alice@example.com", "correct-horse-battery");
  const login = (password: string) =>
    post(
      "/login",
      { email: "alice@example.com", password },
      { "cf-connecting-ip": randomIp() },
    );

  const bad = await login("wrong-password");
  expect(bad.status).toBe(401);
  expect(await bad.json()).toEqual({
    success: false,
    error: "Invalid email or password",
  });

  // A correct login resets the account's count...
  expect((await login("correct-horse-battery")).status).toBe(200);
  for (let i = 0; i < 10; i++) {
    expect((await login(`wrong-${i}`)).status).toBe(401);
  }
  // ...but 10 failures in a window lock further attempts, even correct ones.
  expect((await login("correct-horse-battery")).status).toBe(429);
});

it("register succeeds (and does not leak the transport error) when the verification email fails", async () => {
  vi.spyOn(emailService, "sendVerificationEmail").mockRejectedValue(
    new TypeError("fetch failed"),
  );
  const res = await post(
    "/register",
    { email: "new@example.com", password: "long-enough-pw" },
    { "cf-connecting-ip": randomIp() },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    requiresVerification?: boolean;
    emailSent?: boolean;
  };
  expect(body.requiresVerification).toBe(true);
  expect(body.emailSent).toBe(false);
  expect(JSON.stringify(body)).not.toContain("fetch failed");
  // The code exists, so "resend" (or the code, once delivered) still works.
  expect(
    await EmailVerification.countDocuments({ email: "new@example.com" }),
  ).toBe(1);

  // Resend while email is still down: a clean 503, not the raw error.
  const resend = await post(
    "/resend-verification",
    { email: "new@example.com" },
    { "cf-connecting-ip": randomIp() },
  );
  expect(resend.status).toBe(503);
  expect(JSON.stringify(await resend.json())).not.toContain("fetch failed");

  // Logging in unverified tells the user to verify, not "fetch failed".
  const login = await post(
    "/login",
    { email: "new@example.com", password: "long-enough-pw" },
    { "cf-connecting-ip": randomIp() },
  );
  expect(login.status).toBe(403);
  const loginBody = (await login.json()) as { error?: string };
  expect(loginBody.error).toMatch(/verify your email/);
  expect(JSON.stringify(loginBody)).not.toContain("fetch failed");
});

it("an unexpected failure is a generic 500, never the internal message", async () => {
  vi.spyOn(User, "findOne").mockImplementation(() => {
    throw new Error("MongoServerSelectionError: connect ECONNREFUSED 10.0.0.5");
  });
  const res = await post(
    "/login",
    { email: "alice@example.com", password: "whatever" },
    { "cf-connecting-ip": randomIp() },
  );
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(text).not.toContain("ECONNREFUSED");
  expect(JSON.parse(text).success).toBe(false);
});
