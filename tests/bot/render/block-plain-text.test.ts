import { describe, expect, it } from "vitest";

import {
  buildAlignedTableText,
  extractInlinePlainText,
  toBlockPlainText,
} from "../../../src/bot/render/block-plain-text.js";
import { parseTelegramBlocks } from "../../../src/bot/render/block-parser.js";

function plainTextOf(markdown: string): string {
  const blocks = parseTelegramBlocks(markdown);
  return blocks.map(toBlockPlainText).join("\n\n");
}

describe("bot/render/block-plain-text", () => {
  describe("extractInlinePlainText", () => {
    it("drops formatting and keeps text content", () => {
      expect(
        extractInlinePlainText([
          { type: "text", text: "a " },
          { type: "bold", children: [{ type: "italic", children: [{ type: "text", text: "b" }] }] },
          { type: "code", text: "c" },
          { type: "link", text: [{ type: "text", text: "d" }], url: "https://example.com" },
        ]),
      ).toBe("a bcd");
    });
  });

  describe("buildAlignedTableText", () => {
    it("pads columns and inserts a divider under the header", () => {
      expect(
        buildAlignedTableText([
          ["id", "name"],
          ["1", "long value"],
        ]),
      ).toBe(["id | name      ", "---|-----------", "1  | long value"].join("\n"));
    });

    it("normalizes ragged rows", () => {
      expect(buildAlignedTableText([["a", "b"], ["c"]])).toBe(
        ["a | b", "--|--", "c |  "].join("\n"),
      );
    });
  });

  describe("toBlockPlainText", () => {
    it("renders a paragraph and a heading as bare text", () => {
      expect(plainTextOf("## Title\n\nSome **text**")).toBe("Title\n\nSome text");
    });

    it("prefixes quote lines", () => {
      expect(plainTextOf("> first\n> second")).toBe("> first\n> second");
    });

    it("renders bullet and ordered markers", () => {
      expect(plainTextOf("- a\n- b")).toBe("- a\n- b");
      expect(plainTextOf("1. a\n2. b")).toBe("1. a\n2. b");
    });

    it("keeps the text of inline spans Telegram draws but plain text cannot", () => {
      expect(plainTextOf("H<sub>2</sub>O, м<sup>2</sup>, ==note==, <kbd>Ctrl</kbd>")).toBe(
        "H2O, м2, note, Ctrl",
      );
    });

    it("marks a task item with its state instead of a bullet", () => {
      expect(plainTextOf("- [x] done\n- [ ] open")).toBe("✅ done\n🔲 open");
    });

    it("indents a nested list under its parent item", () => {
      expect(plainTextOf("1. parent\n   1. child\n2. next")).toBe(
        ["1. parent", "   1. child", "2. next"].join("\n"),
      );
    });

    it("keeps code text as is", () => {
      expect(plainTextOf("```js\nconst a = 1;\n```")).toBe("const a = 1;");
    });

    it("renders a table as aligned text", () => {
      expect(plainTextOf("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
        ["a | b", "--|--", "1 | 2"].join("\n"),
      );
    });

    it("renders a thematic break", () => {
      expect(toBlockPlainText({ type: "rule" })).toBe("──────────");
    });

    it("returns plain block text untouched", () => {
      expect(toBlockPlainText({ type: "plain", text: "## raw" })).toBe("## raw");
    });
  });
});
