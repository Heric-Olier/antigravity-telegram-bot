import { beforeEach, describe, expect, it, vi } from "vitest";
import { promptAttachment } from "../../../src/app/managers/prompt-attachment-manager.js";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("app/managers/prompt-attachment-manager", () => {
  beforeEach(() => {
    promptAttachment.__resetForTests();
  });

  it("starts empty", () => {
    expect(promptAttachment.get()).toBeNull();
  });

  it("stores the picked file with its worktree", () => {
    promptAttachment.set("D:\\Repo\\src\\index.ts", "D:\\Repo");

    expect(promptAttachment.get()).toEqual({
      absolutePath: "D:\\Repo\\src\\index.ts",
      worktree: "D:\\Repo",
    });
  });

  it("keeps only the latest file when set twice", () => {
    promptAttachment.set("D:\\Repo\\a.ts", "D:\\Repo");
    promptAttachment.set("D:\\Repo\\b.ts", "D:\\Repo");

    expect(promptAttachment.get()?.absolutePath).toBe("D:\\Repo\\b.ts");
  });

  it("returns a copy so callers cannot mutate internal state", () => {
    promptAttachment.set("D:\\Repo\\a.ts", "D:\\Repo");

    const snapshot = promptAttachment.get()!;
    snapshot.absolutePath = "D:\\Repo\\hacked.ts";

    expect(promptAttachment.get()?.absolutePath).toBe("D:\\Repo\\a.ts");
  });

  it("remembers the confirmation message so its button can be retired later", () => {
    promptAttachment.set("D:\\Repo\\a.ts", "D:\\Repo");
    promptAttachment.setConfirmationMessageId(555);

    expect(promptAttachment.get()?.confirmationMessageId).toBe(555);
  });

  it("ignores a confirmation id when nothing is attached", () => {
    promptAttachment.setConfirmationMessageId(555);

    expect(promptAttachment.get()).toBeNull();
  });

  it("clears the attachment", () => {
    promptAttachment.set("D:\\Repo\\a.ts", "D:\\Repo");
    promptAttachment.clear("consumed");

    expect(promptAttachment.get()).toBeNull();
  });

  it("clearing an empty attachment is a no-op", () => {
    expect(() => promptAttachment.clear("consumed")).not.toThrow();
    expect(promptAttachment.get()).toBeNull();
  });
});
