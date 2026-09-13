import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllInteractionState,
  clearInteractionErrorState,
  interactionManager,
} from "../../../src/app/managers/interaction-manager.js";
import { permissionManager } from "../../../src/app/managers/permission-manager.js";
import { questionManager } from "../../../src/app/managers/question-manager.js";
import { renameManager } from "../../../src/app/managers/rename-manager.js";
import { taskCreationManager } from "../../../src/app/managers/scheduled-task-creation-manager.js";
import type { PermissionRequest } from "../../../src/app/types/permission.js";
import type { Question } from "../../../src/app/types/question.js";

const TEST_QUESTION: Question = {
  header: "Q1",
  question: "Pick one option",
  options: [
    { label: "Yes", description: "accept" },
    { label: "No", description: "decline" },
  ],
};

const TEST_PERMISSION: PermissionRequest = {
  id: "perm-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm test"],
  metadata: {},
  always: [],
};

describe("app/managers/interaction-error-scope", () => {
  beforeEach(() => {
    clearAllInteractionState("test_setup");
  });

  it("clears only questionManager for the question scope", () => {
    questionManager.startQuestions([TEST_QUESTION], "req-1");
    interactionManager.start({ kind: "question", expectedInput: "callback", metadata: {} });

    clearInteractionErrorState("question", "test_cleanup");

    expect(questionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("keeps an unrelated interaction for the question scope", () => {
    questionManager.startQuestions([TEST_QUESTION], "req-1");
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: {} });

    clearInteractionErrorState("question", "test_cleanup");

    expect(questionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()?.kind).toBe("inline");
  });

  it("clears only permissionManager for the permission scope", () => {
    permissionManager.startPermission(TEST_PERMISSION, 101);
    interactionManager.start({ kind: "permission", expectedInput: "callback", metadata: {} });

    clearInteractionErrorState("permission", "test_cleanup");

    expect(permissionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("clears renameManager and the matching interaction for the rename scope", () => {
    renameManager.startWaiting("session-1", "D:/repo", "Old title");
    interactionManager.start({ kind: "rename", expectedInput: "text", metadata: {} });

    clearInteractionErrorState("rename", "test_cleanup");

    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("keeps an unrelated interaction for the rename scope", () => {
    renameManager.startWaiting("session-1", "D:/repo", "Old title");
    interactionManager.start({ kind: "question", expectedInput: "callback", metadata: {} });

    clearInteractionErrorState("rename", "test_cleanup");

    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()?.kind).toBe("question");
  });

  it("clears taskCreationManager and the matching interaction for the taskCreation scope", () => {
    taskCreationManager.start("project-1", "D:/repo", { providerID: "p", modelID: "m", variant: null }, "build");
    interactionManager.start({ kind: "task", expectedInput: "text", metadata: {} });

    clearInteractionErrorState("taskCreation", "test_cleanup");

    expect(taskCreationManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("clears the interaction unconditionally for the interaction scope", () => {
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: {} });

    clearInteractionErrorState("interaction", "test_cleanup");

    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("does nothing for the none scope", () => {
    questionManager.startQuestions([TEST_QUESTION], "req-1");
    interactionManager.start({ kind: "inline", expectedInput: "callback", metadata: {} });

    clearInteractionErrorState("none", "test_cleanup");

    expect(questionManager.isActive()).toBe(true);
    expect(interactionManager.getSnapshot()?.kind).toBe("inline");
  });
});
