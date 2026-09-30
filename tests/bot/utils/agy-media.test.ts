import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `agy-media-test-${process.pid}`);

vi.mock("../../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({
    mode: "sources",
    appHome: tmpHome,
    envFilePath: "",
    settingsFilePath: "",
    logsDirPath: "",
    runDirPath: "",
    localCommandsDirPath: "",
  }),
}));

import { materializeFileParts } from "../../../src/bot/utils/agy-media.js";

describe("bot/utils/agy-media", () => {
  beforeEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("materializes data-URI file parts into the media dir", async () => {
    const payload = Buffer.from("hello-image-bytes");
    const parts = [
      { type: "text", text: "hola" },
      {
        type: "file",
        mime: "image/jpeg",
        filename: "foto rara!.jpg",
        url: `data:image/jpeg;base64,${payload.toString("base64")}`,
      },
    ];

    const files = await materializeFileParts(parts);

    expect(files).toHaveLength(1);
    const file = files[0] ?? "";
    expect(file.startsWith(path.join(tmpHome, "media"))).toBe(true);
    expect(file.endsWith(".jpg")).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("hello-image-bytes");
  });

  it("does not duplicate the extension when the filename already has it", async () => {
    const payload = Buffer.from("bytes");
    const parts = [
      {
        type: "file",
        mime: "image/jpeg",
        filename: "photo.jpg",
        url: `data:image/jpeg;base64,${payload.toString("base64")}`,
      },
    ];

    const files = await materializeFileParts(parts);

    const file = files[0] ?? "";
    expect(file.endsWith("photo.jpg")).toBe(true);
    expect(file.endsWith(".jpg.jpg")).toBe(false);
  });

  it("skips parts without a usable data URI", async () => {
    const files = await materializeFileParts([
      { type: "file", filename: "x", url: "https://example.com/x.jpg" },
      { type: "file", filename: "y" },
      { type: "text", text: "solo texto" },
    ]);
    expect(files).toHaveLength(0);
  });
});
