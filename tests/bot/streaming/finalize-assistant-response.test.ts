import { describe, expect, it, vi } from "vitest";
import { finalizeAssistantResponse } from "../../../src/bot/streaming/finalize-assistant-response.js";

describe("bot/streaming/finalize-assistant-response", () => {
  it("completes the response stream and sends final text when streamer reports not streamed", async () => {
    const responseStreamer = {
      complete: vi.fn().mockResolvedValue({ streamed: false, telegramMessageIds: [] }),
    };
    const flushPendingServiceMessages = vi.fn().mockResolvedValue(undefined);
    const sendRenderedPart = vi.fn().mockResolvedValue(undefined);
    const keyboard = { keyboard: [[{ text: "A" }]] };

    await finalizeAssistantResponse({
      sessionId: "s1",
      messageId: "m1",
      messageText: "final reply",
      responseStreamer,
      flushPendingServiceMessages,
      prepareStreamingPayload: vi.fn(() => ({
        parts: [
          {
            blocks: [],
            fallbackText: "final reply",
            source: "plain" as const,
          },
        ],
      })),
      renderFinalParts: vi.fn(() => [
        {
          blocks: [
            { type: "paragraph" as const, text: { type: "bold" as const, text: "part 1" } },
          ],
          fallbackText: "part 1",
          source: "blocks" as const,
        },
        {
          blocks: [],
          fallbackText: "part 2",
          source: "plain" as const,
        },
      ]),
      getReplyKeyboard: vi.fn(() => keyboard),
      sendRenderedPart,
    });

    expect(responseStreamer.complete).toHaveBeenCalledWith("s1", "m1", {
      parts: [
        {
          blocks: [],
          fallbackText: "final reply",
          source: "plain",
        },
      ],
      sendOptions: { disable_notification: true, reply_markup: keyboard },
      editOptions: undefined,
    });
    expect(flushPendingServiceMessages).toHaveBeenCalledTimes(1);
    expect(sendRenderedPart).toHaveBeenCalledTimes(2);
    expect(sendRenderedPart).toHaveBeenNthCalledWith(
      1,
      {
        blocks: [{ type: "paragraph", text: { type: "bold", text: "part 1" } }],
        fallbackText: "part 1",
        source: "blocks",
      },
      { disable_notification: true, reply_markup: keyboard },
    );
    expect(sendRenderedPart).toHaveBeenNthCalledWith(
      2,
      {
        blocks: [],
        fallbackText: "part 2",
        source: "plain",
      },
      { disable_notification: true, reply_markup: keyboard },
    );
  });

  it("finalizes streamed messages in place without re-sending", async () => {
    const responseStreamer = {
      complete: vi.fn().mockResolvedValue({ streamed: true, telegramMessageIds: [101] }),
    };
    const flushPendingServiceMessages = vi.fn().mockResolvedValue(undefined);
    const sendRenderedPart = vi.fn().mockResolvedValue(undefined);
    const prepareStreamingPayload = vi.fn(() => ({
      parts: [
        {
          blocks: [],
          fallbackText: "reply",
          source: "plain" as const,
        },
      ],
    }));
    const keyboard = { keyboard: [[{ text: "ctx" }]] };

    await finalizeAssistantResponse({
      sessionId: "s1",
      messageId: "m1",
      messageText: "reply",
      responseStreamer,
      flushPendingServiceMessages,
      prepareStreamingPayload,
      renderFinalParts: vi.fn(() => [
        {
          blocks: [],
          fallbackText: "reply",
          source: "plain" as const,
        },
      ]),
      getReplyKeyboard: vi.fn(() => keyboard),
      sendRenderedPart,
    });

    expect(responseStreamer.complete).toHaveBeenCalledWith("s1", "m1", {
      parts: [
        {
          blocks: [],
          fallbackText: "reply",
          source: "plain",
        },
      ],
      sendOptions: { disable_notification: true, reply_markup: keyboard },
      editOptions: undefined,
    });
    expect(flushPendingServiceMessages).toHaveBeenCalledTimes(1);
    expect(sendRenderedPart).not.toHaveBeenCalled();
  });

  it("still sends rendered parts with keyboard when streamer reports not streamed", async () => {
    const responseStreamer = {
      complete: vi.fn().mockResolvedValue({ streamed: false, telegramMessageIds: [] }),
    };
    const flushPendingServiceMessages = vi.fn().mockResolvedValue(undefined);
    const sendRenderedPart = vi.fn().mockResolvedValue(undefined);
    const prepareStreamingPayload = vi.fn(() => ({
      parts: [
        {
          blocks: [],
          fallbackText: "reply",
          source: "plain" as const,
        },
      ],
    }));

    await finalizeAssistantResponse({
      sessionId: "s1",
      messageId: "m1",
      messageText: "reply",
      responseStreamer,
      flushPendingServiceMessages,
      prepareStreamingPayload,
      renderFinalParts: vi.fn(() => [
        {
          blocks: [],
          fallbackText: "reply",
          source: "plain" as const,
        },
      ]),
      getReplyKeyboard: vi.fn(() => undefined),
      sendRenderedPart,
    });

    expect(sendRenderedPart).toHaveBeenCalledTimes(1);
    expect(sendRenderedPart).toHaveBeenCalledWith(
      {
        blocks: [],
        fallbackText: "reply",
        source: "plain",
      },
      { disable_notification: true },
    );
  });
});

