import { describe, expect, it } from "vitest";
import {
  extractErrorMessage,
  isServerUnavailableError,
} from "../../src/utils/opencode-error.js";

describe("utils/opencode-error", () => {
  describe("extractErrorMessage", () => {
    it("extracts the message from Error instances", () => {
      expect(extractErrorMessage(new Error("boom"))).toBe("boom");
    });

    it("returns strings as-is, trimmed", () => {
      expect(extractErrorMessage("oops")).toBe("oops");
      expect(extractErrorMessage("  oops  ")).toBe("oops");
    });

    it("extracts data.message from SDK-style error objects", () => {
      expect(
        extractErrorMessage({ name: "UnknownError", data: { message: "Model not found." } }),
      ).toBe("Model not found.");
    });

    it("falls through whitespace-only values to the next candidate", () => {
      expect(
        extractErrorMessage({ name: "UnknownError", data: { message: "   " }, message: "fallback" }),
      ).toBe("fallback");
    });

    it("falls back to the name when no message is present", () => {
      expect(extractErrorMessage({ name: "UnknownError" })).toBe("UnknownError");
    });

    it("returns null for unusable values", () => {
      expect(extractErrorMessage(null)).toBeNull();
      expect(extractErrorMessage(undefined)).toBeNull();
      expect(extractErrorMessage(42)).toBeNull();
      expect(extractErrorMessage({})).toBeNull();
    });
  });

  describe("isServerUnavailableError", () => {
    it("detects a marker inside an Error message", () => {
      expect(isServerUnavailableError(new Error("fetch failed"))).toBe(true);
    });

    it("detects a marker in a plain string", () => {
      expect(isServerUnavailableError("econnrefused")).toBe(true);
    });

    it("walks the Error cause chain", () => {
      const root = new Error("connection refused");
      const wrapper = new Error("wrapped", { cause: root });
      expect(isServerUnavailableError(wrapper)).toBe(true);
    });

    it("walks plain-object causes and code fields", () => {
      expect(
        isServerUnavailableError({ message: "boom", cause: { code: "ECONNREFUSED" } }),
      ).toBe(true);
    });

    it("returns false for unrelated errors and empty values", () => {
      expect(isServerUnavailableError(new Error("timeout"))).toBe(false);
      expect(isServerUnavailableError(null)).toBe(false);
      expect(isServerUnavailableError(undefined)).toBe(false);
    });
  });
});
