import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { Pipeline } from "../src/core/pipeline.ts";
import { QueueClosedError } from "../src/core/queue.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

/** Records every frame it sees, then forwards it downstream. */
class Stage extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
    this.push(frame);
  }

  /** The kinds of the frames seen, in order. */
  get kinds(): string[] {
    return this.seen.map((frame) => frame.kind);
  }
}

/** Waits until a condition holds, so tests do not depend on timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was never met");
}

describe("Pipeline", () => {
  test("links the processors in order", () => {
    const first = new Stage("first");
    const second = new Stage("second");
    const third = new Stage("third");

    const pipeline = new Pipeline([first, second, third]);

    expect(pipeline.processors).toEqual([first, second, third]);
    expect(pipeline.head).toBe(first);
    expect(pipeline.tail).toBe(third);
    expect(first.next).toBe(second);
    expect(second.next).toBe(third);
    expect(third.prev).toBe(second);
  });

  test("leaves the ends of the chain open", () => {
    const pipeline = new Pipeline([new Stage("first"), new Stage("second")]);

    expect(pipeline.head.prev).toBeUndefined();
    expect(pipeline.tail.next).toBeUndefined();
  });

  test("rejects an empty pipeline", () => {
    expect(() => new Pipeline([])).toThrow("at least one processor");
  });

  test("copies the processor list", () => {
    const stages = [new Stage("first"), new Stage("second")];
    const pipeline = new Pipeline(stages);

    stages.pop();

    expect(pipeline.processors).toHaveLength(2);
  });

  test("injects a frame at the head", async () => {
    const first = new Stage("first");
    const second = new Stage("second");
    const pipeline = new Pipeline([first, second]);
    const firstRunning = first.run();
    const secondRunning = second.run();

    pipeline.push(createFrame({ kind: "llmRun" }));

    await until(() => second.seen.length === 1);
    expect(first.kinds).toEqual(["llmRun"]);
    expect(second.kinds).toEqual(["llmRun"]);

    first.close();
    second.close();
    await Promise.all([firstRunning, secondRunning]);
  });

  test("refuses a frame once the head has stopped", async () => {
    const pipeline = new Pipeline([new Stage("only")]);
    pipeline.head.close();

    expect(() => pipeline.push(createFrame({ kind: "llmRun" }))).toThrow(QueueClosedError);
  });
});
