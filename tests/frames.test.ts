import { describe, expect, test } from "bun:test";

import { createFrame } from "../src/frames/index.ts";

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
