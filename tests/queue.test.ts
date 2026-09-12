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
