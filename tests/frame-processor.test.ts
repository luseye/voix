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

/** Records every frame it sees, then forwards it downstream. */
class Relay extends Sink {
  protected override async process(frame: Frame): Promise<void> {
    this.seen.push(frame);
    this.push(frame);
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

describe("FrameProcessor", () => {
  describe("name", () => {
    test("defaults to the class name", () => {
      expect(new Sink().name).toBe("Sink");
      expect(new Sink("custom").name).toBe("custom");
    });
  });

  describe("link", () => {
    test("links both ways, leaving the ends open", () => {
      const first = new Sink("first");
      const second = new Sink("second");

      first.link(second);

      expect(first.next).toBe(second);
      expect(second.prev).toBe(first);
      expect(first.prev).toBeUndefined();
      expect(second.next).toBeUndefined();
    });

    test("chains more than two processors", () => {
      const first = new Sink("first");
      const second = new Sink("second");
      const third = new Sink("third");

      first.link(second);
      second.link(third);

      expect(first.next).toBe(second);
      expect(second.prev).toBe(first);
      expect(second.next).toBe(third);
      expect(third.prev).toBe(second);
    });
  });

  describe("push", () => {
    test("carries a frame along a chain", async () => {
      const source = new Relay("source");
      const middle = new Relay("middle");
      const tail = new Sink("tail");
      source.link(middle);
      middle.link(tail);
      const middleRunning = middle.run();
      const tailRunning = tail.run();

      source.push(createFrame({ kind: "llmRun" }));

      await until(() => tail.seen.length === 1);
      expect(middle.kinds).toEqual(["llmRun"]);
      expect(tail.kinds).toEqual(["llmRun"]);

      middle.close();
      tail.close();
      await Promise.all([middleRunning, tailRunning]);
    });

    test("queues a frame on the previous processor when sent up", async () => {
      const head = new Sink("head");
      const source = new Relay("source");
      head.link(source);
      const running = head.run();

      source.push(createFrame({ kind: "cancel" }), "up");

      await until(() => head.seen.length === 1);
      expect(head.kinds).toEqual(["cancel"]);

      head.close();
      await running;
    });

    test("does not wait for the neighbour to handle the frame", async () => {
      let release: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });

      class Slow extends Sink {
        /** Set once the first frame has been picked up and is being awaited. */
        entered = false;

        protected override async process(frame: Frame): Promise<void> {
          this.entered = true;
          await blocked;
          this.seen.push(frame);
        }
      }

      const source = new Relay("source");
      const target = new Slow("target");
      source.link(target);
      const running = target.run();

      // The first frame occupies the neighbour. The second is pushed while it
      // is still busy, so the push has to return without waiting for it.
      source.push(createFrame({ kind: "llmRun" }));
      await until(() => target.entered);
      source.push(createFrame({ kind: "llmRun" }));

      // The neighbour has not handled it yet, but push has already returned.
      expect(target.queueSize).toBe(1);

      release();
      await until(() => target.seen.length === 2);

      target.close();
      await running;
    });

    test("reports a dropped frame when there is no neighbour", () => {
      const lonely = new Sink("lonely");

      expect(lonely.push(createFrame({ kind: "llmRun" }))).toBe(false);
      expect(lonely.push(createFrame({ kind: "llmRun" }), "up")).toBe(false);
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
