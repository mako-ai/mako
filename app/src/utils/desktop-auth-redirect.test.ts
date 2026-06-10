import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setPendingDesktopAuthChallenge,
  getPendingDesktopAuthChallenge,
  clearPendingDesktopAuthChallenge,
  hasPendingDesktopAuth,
  isValidDesktopAuthChallenge,
} from "./desktop-auth-redirect";

// S256 challenges are 43-char base64url strings
const VALID_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function createSessionStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("desktop-auth-redirect", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createSessionStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isValidDesktopAuthChallenge", () => {
    it("accepts a 43-char base64url S256 challenge", () => {
      expect(isValidDesktopAuthChallenge(VALID_CHALLENGE)).toBe(true);
    });

    it("rejects null, undefined and empty strings", () => {
      expect(isValidDesktopAuthChallenge(null)).toBe(false);
      expect(isValidDesktopAuthChallenge(undefined)).toBe(false);
      expect(isValidDesktopAuthChallenge("")).toBe(false);
    });

    it("rejects strings that are too short or contain invalid chars", () => {
      expect(isValidDesktopAuthChallenge("short")).toBe(false);
      expect(isValidDesktopAuthChallenge("a".repeat(129))).toBe(false);
      expect(
        isValidDesktopAuthChallenge(`${VALID_CHALLENGE.slice(0, -1)}+`),
      ).toBe(false);
      expect(
        isValidDesktopAuthChallenge(`${VALID_CHALLENGE.slice(0, -1)}=`),
      ).toBe(false);
    });
  });

  describe("pending challenge round trip", () => {
    it("stores, reads, and clears a valid challenge", () => {
      expect(hasPendingDesktopAuth()).toBe(false);

      setPendingDesktopAuthChallenge(VALID_CHALLENGE);
      expect(getPendingDesktopAuthChallenge()).toBe(VALID_CHALLENGE);
      expect(hasPendingDesktopAuth()).toBe(true);

      clearPendingDesktopAuthChallenge();
      expect(getPendingDesktopAuthChallenge()).toBeNull();
      expect(hasPendingDesktopAuth()).toBe(false);
    });

    it("ignores invalid challenges on write", () => {
      setPendingDesktopAuthChallenge("not a challenge");
      expect(getPendingDesktopAuthChallenge()).toBeNull();
    });

    it("ignores tampered values on read", () => {
      sessionStorage.setItem("desktopAuthChallenge", "garbage!!");
      expect(getPendingDesktopAuthChallenge()).toBeNull();
      expect(hasPendingDesktopAuth()).toBe(false);
    });

    it("does not throw when sessionStorage is unavailable", () => {
      vi.stubGlobal("sessionStorage", undefined);
      expect(() =>
        setPendingDesktopAuthChallenge(VALID_CHALLENGE),
      ).not.toThrow();
      expect(getPendingDesktopAuthChallenge()).toBeNull();
      expect(hasPendingDesktopAuth()).toBe(false);
      expect(() => clearPendingDesktopAuthChallenge()).not.toThrow();
    });
  });
});
