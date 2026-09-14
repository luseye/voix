import { describe, expect, test } from "bun:test";

import { AsyncQueue, QueueClosedError } from "../src/core/queue.ts";

describe("AsyncQueue", () => {
  describe("push and pop", () => {
    test("returns a pushed item", async () => {
      const queue = new AsyncQueue<string>();
      queue.push("a");

      expect(await queue.pop()).toBe("a");
    });

    test("returns items in the order they were pushed", async () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);
      queue.push(3);

      expect(await queue.pop()).toBe(1);
      expect(await queue.pop()).toBe(2);
      expect(await queue.pop()).toBe(3);
    });

    test("waits for an item when empty", async () => {
      const queue = new AsyncQueue<string>();
      const pending = queue.pop();

      queue.push("late");

      expect(await pending).toBe("late");
    });

    test("resumes several waiting consumers in order", async () => {
      const queue = new AsyncQueue<number>();
      const first = queue.pop();
      const second = queue.pop();

      queue.push(1);
      queue.push(2);

      expect(await first).toBe(1);
      expect(await second).toBe(2);
    });

    test("hands an item to a waiting consumer without queueing it", async () => {
      const queue = new AsyncQueue<string>();
      const pending = queue.pop();

      queue.push("handed over");

      expect(queue.size).toBe(0);
      expect(await pending).toBe("handed over");
    });
  });

  describe("priority", () => {
    test("dequeues lower priority values first", async () => {
      const queue = new AsyncQueue<string>((item) => (item === "low" ? 20 : 1));
      queue.push("low");
      queue.push("high");

      expect(await queue.pop()).toBe("high");
      expect(await queue.pop()).toBe("low");
    });

    test("orders across three priorities", async () => {
      const rank: Record<string, number> = { data: 20, system: 10, start: 1 };
      const queue = new AsyncQueue<string>((item) => rank[item]!);
      queue.push("data");
      queue.push("system");
      queue.push("start");

      expect(await queue.pop()).toBe("start");
      expect(await queue.pop()).toBe("system");
      expect(await queue.pop()).toBe("data");
    });

    test("keeps equal priority items in arrival order", async () => {
      const queue = new AsyncQueue<string>(() => 1);
      queue.push("first");
      queue.push("second");
      queue.push("third");

      expect(await queue.pop()).toBe("first");
      expect(await queue.pop()).toBe("second");
      expect(await queue.pop()).toBe("third");
    });

    test("keeps arrival order within a priority band", async () => {
      const queue = new AsyncQueue<string>((item) => (item.startsWith("data") ? 20 : 1));
      queue.push("data-1");
      queue.push("system-1");
      queue.push("data-2");
      queue.push("system-2");

      expect(await queue.pop()).toBe("system-1");
      expect(await queue.pop()).toBe("system-2");
      expect(await queue.pop()).toBe("data-1");
      expect(await queue.pop()).toBe("data-2");
    });

    test("ignores priority when handing off to a waiting consumer", async () => {
      const queue = new AsyncQueue<string>((item) => (item === "low" ? 20 : 1));
      const pending = queue.pop();

      queue.push("low");

      // Nothing is queued, so there is no ordering to apply.
      expect(queue.size).toBe(0);
      expect(await pending).toBe("low");
    });
  });

  describe("size", () => {
    test("counts waiting items", () => {
      const queue = new AsyncQueue<number>();
      expect(queue.size).toBe(0);
      expect(queue.isEmpty).toBe(true);

      queue.push(1);
      queue.push(2);

      expect(queue.size).toBe(2);
      expect(queue.isEmpty).toBe(false);
    });
  });

  describe("removeWhere", () => {
    test("removes matching items and reports how many", () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.push(4);

      const removed = queue.removeWhere((item) => item % 2 === 0);

      expect(removed).toBe(2);
      expect(queue.size).toBe(2);
    });

    test("keeps the surviving items in order", async () => {
      const queue = new AsyncQueue<string>();
      queue.push("keep-1");
      queue.push("drop-1");
      queue.push("keep-2");
      queue.push("drop-2");
      queue.push("keep-3");

      queue.removeWhere((item) => item.startsWith("drop"));

      expect(await queue.pop()).toBe("keep-1");
      expect(await queue.pop()).toBe("keep-2");
      expect(await queue.pop()).toBe("keep-3");
    });

    test("removes nothing when nothing matches", () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);

      expect(queue.removeWhere(() => false)).toBe(0);
      expect(queue.size).toBe(2);
    });

    test("removes everything when all match", () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);

      expect(queue.removeWhere(() => true)).toBe(2);
      expect(queue.isEmpty).toBe(true);
    });

    test("leaves a waiting consumer undisturbed", async () => {
      const queue = new AsyncQueue<number>();
      const pending = queue.pop();

      expect(queue.removeWhere(() => true)).toBe(0);

      // A consumer only waits while the queue is empty, so there is nothing
      // to remove and the wait must still be honoured.
      queue.push(1);
      expect(await pending).toBe(1);
    });
  });

  describe("close", () => {
    test("drains queued items before returning undefined", async () => {
      const queue = new AsyncQueue<number>();
      queue.push(1);
      queue.push(2);
      queue.close();

      expect(await queue.pop()).toBe(1);
      expect(await queue.pop()).toBe(2);
      expect(await queue.pop()).toBeUndefined();
    });

    test("releases waiting consumers with undefined", async () => {
      const queue = new AsyncQueue<string>();
      const pending = queue.pop();

      queue.close();

      expect(await pending).toBeUndefined();
    });

    test("returns immediately when closed and empty", async () => {
      const queue = new AsyncQueue<string>();
      queue.close();

      expect(await queue.pop()).toBeUndefined();
    });

    test("rejects further pushes", () => {
      const queue = new AsyncQueue<string>();
      queue.close();

      expect(() => queue.push("late")).toThrow(QueueClosedError);
    });

    test("is idempotent", () => {
      const queue = new AsyncQueue<string>();
      queue.close();
      queue.close();

      expect(queue.isClosed).toBe(true);
    });

    test("reports its state", () => {
      const queue = new AsyncQueue<string>();
      expect(queue.isClosed).toBe(false);

      queue.close();

      expect(queue.isClosed).toBe(true);
    });
  });
});
