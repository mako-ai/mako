import assert from "node:assert/strict";
import {
  getRequestBaseUrl,
  isLoopbackOrPrivateHostname,
  resolveWebhookBaseUrl,
} from "./flow-webhook-url";

const request = (url: string, headers: Record<string, string> = {}) => ({
  req: {
    url,
    header: (name: string) => headers[name.toLowerCase()],
  },
});

for (const host of [
  "localhost",
  "app.localhost",
  "127.0.0.1",
  "::1",
  "10.1.2.3",
  "192.168.0.10",
  "172.16.0.1",
  "172.31.255.255",
]) {
  assert.ok(isLoopbackOrPrivateHostname(host), `${host} is private`);
}
for (const host of ["172.15.0.1", "172.32.0.1", "example.com", "8.8.8.8"]) {
  assert.ok(!isLoopbackOrPrivateHostname(host), `${host} is public`);
}

// Forwarding headers win over the raw URL, first value of a list.
assert.equal(
  getRequestBaseUrl(
    request("http://10.0.0.5:8080/api/x", {
      "x-forwarded-host": "app.example.com, proxy.internal",
      "x-forwarded-proto": "https",
    }),
  ),
  "https://app.example.com",
);
assert.equal(
  getRequestBaseUrl(request("http://localhost:8080/api/x")),
  "http://localhost:8080",
  "no host header: the request origin",
);

// A caller-supplied public origin is taken as-is (origin only).
assert.equal(
  resolveWebhookBaseUrl(
    request("http://localhost:8080/x"),
    "https://tunnel.example.com/some/path",
  ),
  "https://tunnel.example.com",
);
// A public request origin is used directly.
assert.equal(
  resolveWebhookBaseUrl(request("https://mako.example.com/x")),
  "https://mako.example.com",
);

// A private request origin falls back to the first public env candidate.
const saved = {
  WEBHOOK_PUBLIC_BASE_URL: process.env.WEBHOOK_PUBLIC_BASE_URL,
  PUBLIC_URL: process.env.PUBLIC_URL,
  API_BASE_URL: process.env.API_BASE_URL,
  BASE_URL: process.env.BASE_URL,
};
try {
  process.env.WEBHOOK_PUBLIC_BASE_URL = "http://localhost:5173";
  process.env.PUBLIC_URL = "https://public.example.com/app";
  delete process.env.API_BASE_URL;
  delete process.env.BASE_URL;
  assert.equal(
    resolveWebhookBaseUrl(request("http://localhost:8080/x")),
    "https://public.example.com",
  );
  // Nothing public anywhere: the request origin, unreachable as it is.
  process.env.PUBLIC_URL = "http://127.0.0.1:5173";
  assert.equal(
    resolveWebhookBaseUrl(request("http://localhost:8080/x")),
    "http://localhost:8080",
  );
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("flow webhook URL resolution: all assertions passed");
