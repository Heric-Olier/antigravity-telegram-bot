import { describe, expect, it } from "vitest";
import {
  formatModelForButton,
  formatModelForDisplay,
  idToButtonLabel,
} from "../../../src/app/types/model.js";

describe("model/types", () => {
  it("formats antigravity models as friendly single-line labels", () => {
    expect(formatModelForButton("antigravity", "gemini-3.8-flash-medium")).toBe(
      "🧠 Gemini 3.8 Flash (Medium)",
    );
  });

  it("keeps the provider suffix for non-antigravity providers", () => {
    expect(formatModelForButton("openai", "gpt-4o")).toBe("🧠 gpt-4o · openai");
  });

  it("truncates only beyond the button width budget", () => {
    const result = formatModelForButton(
      "antigravity",
      "some-unknown-family-model-id-that-is-long",
    );

    expect(result.startsWith("🧠 ")).toBe(true);
    expect(result.endsWith("...")).toBe(true);
  });

  it("maps antigravity-style ids to readable labels", () => {
    expect(idToButtonLabel("gemini-3.8-flash-medium")).toBe("Gemini 3.8 Flash (Medium)");
    expect(idToButtonLabel("gemini-3.1-pro-high")).toBe("Gemini 3.1 Pro (High)");
    expect(idToButtonLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4 6");
    expect(idToButtonLabel("gpt-oss-120b-medium")).toBe("gpt-oss-120b-medium");
  });

  it("falls back to the raw id when it is not a known pattern", () => {
    expect(idToButtonLabel("openai/gpt-4o")).toBe("openai/gpt-4o");
  });

  it("formats model for display", () => {
    expect(formatModelForDisplay("anthropic", "claude-sonnet")).toBe("anthropic / claude-sonnet");
  });
});
