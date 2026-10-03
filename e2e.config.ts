import { randomBytes, randomUUID } from "node:crypto";
import { config } from "dotenv";
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { registrationCode } from "./tests/e2e/verification";

config({ path: ".env.e2e.local" });
const baseURL = new URL(process.env.MAKO_E2E_BASE_URL ?? "http://localhost:5173");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(baseURL.hostname);
const preview = baseURL.protocol === "https:" && /^pr-\d+\.mako\.ai$/.test(baseURL.hostname);
if (!local && !preview) throw new Error("E2E account creation is restricted to localhost or a Mako PR preview.");
if (preview && (!process.env.MAKO_E2E_EMAIL || !process.env.MAKO_E2E_VERIFICATION_FILE)) {
  throw new Error("PR previews require a fresh MAKO_E2E_EMAIL and MAKO_E2E_VERIFICATION_FILE for its real email code.");
}
// Inherited by workers, so the config and the OTP reader use the same account.
process.env.MAKO_E2E_EMAIL ??= `mako-e2e+${randomUUID()}@example.test`;
process.env.MAKO_E2E_PASSWORD ??= randomBytes(24).toString("hex");

export default {
  tests: "tests/e2e/**/*.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  assertionTimeout: 15_000,
  trace: "retain-on-failure",
  credentials: {
    signup: {
      username: process.env.MAKO_E2E_EMAIL,
      password: process.env.MAKO_E2E_PASSWORD,
    },
  },
  secrets: {
    verificationCode: () => registrationCode(process.env.MAKO_E2E_EMAIL!),
  },
  targets: [
    {
      name: "chromium",
      engine: web(),
      app: { url: baseURL.href },
    },
  ],
} satisfies E2EConfig;
