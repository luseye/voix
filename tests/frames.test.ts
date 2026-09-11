import { describe, expect, test } from "bun:test";

import {
  createFrame,
  framePriority,
  isInterruptible,
  TIER_PRIORITY,
  type Frame,
  type FrameKind,
} from "../src/frames/index.ts";

describe("createFrame", () => {
  test("attaches an id", () => {
    const frame = createFrame({ kind: "end" });

    expect(frame.kind).toBe("end");
    expect(typeof frame.id).toBe("number");
  });

  test("assigns a distinct id to every frame", () => {
    const first = createFrame({ kind: "llmRun" });
    const second = createFrame({ kind: "llmRun" });

    expect(first.id).not.toBe(second.id);
  });

  test("keeps the frame body intact", () => {
    const frame = createFrame({ kind: "transcript", text: "hello", final: true });

    expect(frame).toMatchObject({ kind: "transcript", text: "hello", final: true });
  });

  test("preserves the narrowed body type", () => {
    const data = Int16Array.from([1, 2, 3]);
    const frame = createFrame({ kind: "inputAudio", data });

    // Reaching `frame.data` without a cast only compiles while createFrame
    // keeps the body type instead of widening to the full union.
    expect(frame.data).toBe(data);
  });
});

describe("framePriority", () => {
  test("schedules the start frame ahead of everything", () => {
    const start = createFrame({ kind: "start", sampleRateIn: 16000, sampleRateOut: 24000 });
    const audio = createFrame({ kind: "inputAudio", data: new Int16Array(0) });

    expect(framePriority(start)).toBeLessThan(framePriority(audio));
  });

  test("schedules system frames ahead of data frames", () => {
    const interrupt = createFrame({ kind: "interrupt" });
    const text = createFrame({ kind: "llmText", text: "hi" });

    expect(framePriority(interrupt)).toBeLessThan(framePriority(text));
  });

  test("schedules data frames at the default tier", () => {
    const text = createFrame({ kind: "llmText", text: "hi" });

    expect(framePriority(text)).toBe(TIER_PRIORITY.default);
  });

  test("gives every frame kind a priority", () => {
    const frames: Frame[] = [
      createFrame({ kind: "start", sampleRateIn: 16000, sampleRateOut: 24000 }),
      createFrame({ kind: "end" }),
      createFrame({ kind: "cancel" }),
      createFrame({ kind: "interrupt" }),
      createFrame({ kind: "inputAudio", data: new Int16Array(0) }),
      createFrame({ kind: "ttsAudio", data: new Int16Array(0) }),
      createFrame({ kind: "transcript", text: "hi", final: false }),
      createFrame({ kind: "llmText", text: "hi" }),
      createFrame({ kind: "ttsText", text: "hi" }),
      createFrame({ kind: "userStartedSpeaking" }),
      createFrame({ kind: "userStoppedSpeaking" }),
      createFrame({ kind: "botStartedSpeaking" }),
      createFrame({ kind: "botStoppedSpeaking" }),
      createFrame({ kind: "llmRun" }),
    ];

    for (const frame of frames) {
      expect(typeof framePriority(frame)).toBe("number");
    }
  });
});

describe("isInterruptible", () => {
  test("protects lifecycle frames", () => {
    expect(isInterruptible(createFrame({ kind: "end" }))).toBe(false);
    expect(isInterruptible(createFrame({ kind: "cancel" }))).toBe(false);
    expect(isInterruptible(createFrame({ kind: "interrupt" }))).toBe(false);
  });

  test("protects speaking state frames", () => {
    expect(isInterruptible(createFrame({ kind: "userStartedSpeaking" }))).toBe(false);
    expect(isInterruptible(createFrame({ kind: "botStoppedSpeaking" }))).toBe(false);
  });

  test("discards data frames", () => {
    expect(isInterruptible(createFrame({ kind: "llmText", text: "hi" }))).toBe(true);
    expect(isInterruptible(createFrame({ kind: "ttsAudio", data: new Int16Array(0) }))).toBe(true);
    expect(isInterruptible(createFrame({ kind: "transcript", text: "hi", final: false }))).toBe(
      true,
    );
  });
});

describe("exhaustiveness", () => {
  test("every frame kind is handled by a switch", () => {
    // A switch over the union with no default compiles only while every kind
    // is covered, so this stops building if a kind is added and not handled.
    const classify = (frame: Frame): FrameKind => {
      switch (frame.kind) {
        case "start":
        case "end":
        case "cancel":
        case "interrupt":
        case "inputAudio":
        case "ttsAudio":
        case "transcript":
        case "llmText":
        case "ttsText":
        case "userStartedSpeaking":
        case "userStoppedSpeaking":
        case "botStartedSpeaking":
        case "botStoppedSpeaking":
        case "llmRun":
          return frame.kind;
      }
    };

    expect(classify(createFrame({ kind: "llmRun" }))).toBe("llmRun");
  });
});
