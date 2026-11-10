import { describe, expect, it } from "vitest";
import {
  forgetKeyLinkToken,
  takeKeyLinkToken,
  type KeyLinkEnv,
} from "./key-link-token";

const TOKEN = "p4_s72QtfeBefVL2BDUNn0RSgZPuqOmldpoawvZEZV8";

function fakeEnv(hash: string): KeyLinkEnv & {
  url: string;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const env = {
    hash,
    pathname: "/connection-key/ws1",
    search: "",
    url: `/connection-key/ws1${hash}`,
    store,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    replaceUrl: (url: string) => {
      env.url = url;
    },
  };
  return env;
}

describe("key link token", () => {
  it("takes the token off the address bar, so no tracked URL carries it", () => {
    const env = fakeEnv(`#${TOKEN}`);
    expect(takeKeyLinkToken("ws1", env)).toBe(TOKEN);
    expect(env.url).toBe("/connection-key/ws1");
    expect(env.url).not.toContain(TOKEN);
    // The page path an analytics tag records never had it in the first place.
    expect(env.pathname).not.toContain(TOKEN);
  });

  it("survives a sign-in round trip in this tab, then is forgotten", () => {
    const env = fakeEnv(`#${TOKEN}`);
    takeKeyLinkToken("ws1", env);
    const back = { ...env, hash: "" };
    expect(takeKeyLinkToken("ws1", back)).toBe(TOKEN);
    forgetKeyLinkToken("ws1", back);
    expect(takeKeyLinkToken("ws1", back)).toBe("");
  });
});
