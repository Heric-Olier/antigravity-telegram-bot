import { describe, expect, it } from "vitest";

import {
  normalizeBlockSplitLimits,
  splitOversizeTelegramBlock,
} from "../../../src/bot/render/block-splitter.js";
import { countRichBlocks, countRichChars, toRichBlock } from "../../../src/bot/render/rich-blocks.js";
import type {
  InlineNode,
  TelegramBlock,
  TelegramListItem,
} from "../../../src/bot/render/types.js";

function textNodes(text: string): InlineNode[] {
  return [{ type: "text", text }];
}

function listItem(text: string): TelegramListItem {
  return { blocks: [{ type: "paragraph", inlines: textNodes(text) }] };
}

function expectAllFit(blocks: TelegramBlock[], maxChars: number, maxBlocks: number): void {
  for (const block of blocks) {
    const rich = toRichBlock(block);
    expect(countRichChars(rich)).toBeLessThanOrEqual(maxChars);
    expect(countRichBlocks(rich)).toBeLessThanOrEqual(maxBlocks);
  }
}

describe("bot/render/block-splitter", () => {
  it("leaves a block that already fits untouched", () => {
    const block: TelegramBlock = { type: "paragraph", inlines: textNodes("short") };

    expect(splitOversizeTelegramBlock(block, normalizeBlockSplitLimits())).toEqual([block]);
  });

  it("splits an oversized code block on line boundaries and keeps the language", () => {
    const limits = { maxChars: 40, maxBlocks: 100 };
    const code = Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n");

    const pieces = splitOversizeTelegramBlock({ type: "code", language: "ts", text: code }, limits);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.type === "code" && piece.language === "ts")).toBe(true);
    expect(pieces.map((piece) => (piece.type === "code" ? piece.text : "")).join("\n")).toBe(code);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("splits an oversized table by rows and repeats the header", () => {
    const limits = { maxChars: 10_000, maxBlocks: 6 };
    const rows = [
      ["h1", "h2"],
      ...Array.from({ length: 12 }, (_, index) => [`a${index}`, `b${index}`]),
    ];

    const pieces = splitOversizeTelegramBlock({ type: "table", rows }, limits);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.type).toBe("table");
      if (piece.type === "table") {
        expect(piece.rows[0]).toEqual(["h1", "h2"]);
      }
    }

    const bodyRows = pieces.flatMap((piece) => (piece.type === "table" ? piece.rows.slice(1) : []));
    expect(bodyRows).toEqual(rows.slice(1));
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("splits an oversized bullet list by items", () => {
    const limits = { maxChars: 10_000, maxBlocks: 9 };
    const items = Array.from({ length: 10 }, (_, index) => listItem(`item ${index}`));

    const pieces = splitOversizeTelegramBlock({ type: "list", ordered: false, items }, limits);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.type === "list" && !piece.ordered)).toBe(true);
    expect(
      pieces.flatMap((piece) => (piece.type === "list" ? piece.items : [])),
    ).toEqual(items);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  // An ordered list maps to a single paragraph, so only its length can force a split.
  it("splits an oversized ordered list on characters and keeps every item", () => {
    const limits = { maxChars: 200, maxBlocks: 500 };
    const items = Array.from({ length: 20 }, (_, index) =>
      listItem(`item ${index} ${"x".repeat(30)}`),
    );

    const pieces = splitOversizeTelegramBlock({ type: "list", ordered: true, items }, limits);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.type === "list" && piece.ordered)).toBe(true);
    expect(
      pieces.flatMap((piece) => (piece.type === "list" ? piece.items : [])),
    ).toEqual(items);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("splits a bullet list whose items carry nested content without degrading it", () => {
    const limits = { maxChars: 10_000, maxBlocks: 12 };
    const items: TelegramListItem[] = Array.from({ length: 8 }, (_, index) => ({
      blocks: [
        { type: "paragraph", inlines: textNodes(`item ${index}`) },
        { type: "list", ordered: false, items: [listItem(`child ${index}`)] },
      ],
    }));

    const pieces = splitOversizeTelegramBlock({ type: "list", ordered: false, items }, limits);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.type === "list")).toBe(true);
    expect(
      pieces.flatMap((piece) => (piece.type === "list" ? piece.items : [])),
    ).toEqual(items);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("counts the task marker of an ordered checklist when splitting", () => {
    const limits = { maxChars: 120, maxBlocks: 500 };
    const items: TelegramListItem[] = Array.from({ length: 12 }, (_, index) => ({
      blocks: [{ type: "paragraph", inlines: textNodes(`task ${index} ${"y".repeat(20)}`) }],
      checked: index % 2 === 0,
    }));

    const pieces = splitOversizeTelegramBlock({ type: "list", ordered: true, items }, limits);

    expect(pieces.every((piece) => piece.type === "list" && piece.ordered)).toBe(true);
    expect(
      pieces.flatMap((piece) => (piece.type === "list" ? piece.items : [])),
    ).toEqual(items);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("splits an oversized quote by its content blocks", () => {
    const limits = { maxChars: 10_000, maxBlocks: 4 };
    const blocks: TelegramBlock[] = Array.from({ length: 9 }, (_, index) => ({
      type: "paragraph",
      inlines: textNodes(`quote ${index}`),
    }));

    const pieces = splitOversizeTelegramBlock({ type: "blockquote", blocks }, limits);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.type === "blockquote")).toBe(true);
    expect(
      pieces.flatMap((piece) => (piece.type === "blockquote" ? piece.blocks : [])),
    ).toEqual(blocks);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("degrades a block it cannot split structurally to plain text", () => {
    const limits = { maxChars: 20, maxBlocks: 100 };
    const block: TelegramBlock = {
      type: "paragraph",
      inlines: textNodes("word ".repeat(20).trim()),
    };

    const pieces = splitOversizeTelegramBlock(block, limits);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.type === "plain")).toBe(true);
    expect(pieces.map((piece) => (piece.type === "plain" ? piece.text : "")).join("")).toBe(
      "word ".repeat(20).trim(),
    );
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("degrades a single oversized list item to plain text", () => {
    const limits = { maxChars: 20, maxBlocks: 100 };
    const items = [listItem("x".repeat(200))];

    const pieces = splitOversizeTelegramBlock({ type: "list", ordered: false, items }, limits);

    expect(pieces.every((piece) => piece.type === "plain")).toBe(true);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });

  it("degrades a header-only oversized table to plain text", () => {
    const limits = { maxChars: 20, maxBlocks: 100 };
    const rows = [["h".repeat(60), "g".repeat(60)]];

    const pieces = splitOversizeTelegramBlock({ type: "table", rows }, limits);

    expect(pieces.every((piece) => piece.type === "plain")).toBe(true);
    expectAllFit(pieces, limits.maxChars, limits.maxBlocks);
  });
});
