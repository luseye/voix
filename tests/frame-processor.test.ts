import { describe, expect, test } from "bun:test";

import { FrameProcessor } from "../src/core/frame-processor.ts";
import { QueueClosedError } from "../src/core/queue.ts";
import { createFrame, type Frame } from "../src/frames/index.ts";

/** Records every frame it sees. */
class Sink extends FrameProcessor {
  readonly seen: Frame[] = [];

  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
  }

  /** The kinds of the frames seen, in order. */
  get kinds(): string[] {
    return this.seen.map((frame) => frame.kind);
  }
}

describe("FrameProcessor", () => {
  describe("name", () => {
    test("defaults to the class name", () => {
      expect(new Sink().name).toBe("Sink");
      expect(new Sink("custom").name).toBe("custom");
    });
  });

  describe("run", () => {
    test.each(["end", "cancel"] as const)("stops on a %s frame", async (kind) => {
      const sink = new Sink("sink");
      sink.enqueue(createFrame({ kind }));

      await sink.run();

      expect(sink.kinds).toEqual([kind]);
      expect(sink.isRunning).toBe(false);
    });

    test("processes queued frames in arrival order", async () => {
      const sink = new Sink("sink");
      sink.enqueue(createFrame({ kind: "llmText", text: "one" }));
      sink.enqueue(createFrame({ kind: "llmText", text: "two" }));
      expect(sink.queueSize).toBe(2);
      sink.close();

      await sink.run();

      expect(sink.kinds).toEqual(["llmText", "llmText"]);
      expect(sink.queueSize).toBe(0);
    });

    test("schedules system frames ahead of data frames", async () => {
      const sink = new Sink("sink");
      sink.enqueue(createFrame({ kind: "llmText", text: "data" }));
      sink.enqueue(createFrame({ kind: "end" }));

      await sink.run();

      // The end frame runs first, but the text frame it was queued with is
      // still handled: stopping does not discard queued work.
      expect(sink.kinds).toEqual(["end", "llmText"]);
    });

    test("waits for a frame that arrives later", async () => {
      const sink = new Sink("sink");
      const running = sink.run();

      sink.enqueue(createFrame({ kind: "llmRun" }));
      sink.close();
      await running;

      expect(sink.kinds).toEqual(["llmRun"]);
    });

    test("rejects a second run", async () => {
      const sink = new Sink("sink");
      const running = sink.run();

      await expect(sink.run()).rejects.toThrow("sink is already running");

      sink.close();
      await running;
    });

    test("refuses new frames once stopped", async () => {
      const sink = new Sink("sink");
      const running = sink.run();
      sink.close();
      await running;

      expect(() => sink.enqueue(createFrame({ kind: "llmRun" }))).toThrow(QueueClosedError);
    });

    test("closes the queue when a frame throws", async () => {
      class Failing extends FrameProcessor {
        protected override async process(): Promise<void> {
          throw new Error("boom");
        }
      }

      const failing = new Failing("failing");
      const running = failing.run();
      failing.enqueue(createFrame({ kind: "llmRun" }));

      await expect(running).rejects.toThrow("boom");
      expect(failing.isRunning).toBe(false);
      // Otherwise a producer that kept pushing would wait forever.
      expect(() => failing.enqueue(createFrame({ kind: "llmRun" }))).toThrow(QueueClosedError);
    });
  });
});
