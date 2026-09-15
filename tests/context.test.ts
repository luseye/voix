import { describe, expect, test } from "bun:test";

import { LLMContext } from "../src/core/context.ts";

describe("LLMContext", () => {
  test("starts empty without a system prompt", () => {
    const context = new LLMContext();

    expect(context.getMessages()).toEqual([]);
    expect(context.length).toBe(0);
  });

  test("puts the system prompt first", () => {
    const context = new LLMContext("You are helpful.");

    expect(context.getMessages()).toEqual([{ role: "system", content: "You are helpful." }]);
  });

  test("keeps messages in the order they were added", () => {
    const context = new LLMContext();
    context.addMessage({ role: "user", content: "hello" });
    context.addMessage({ role: "assistant", content: "hi" });
    context.addMessage({ role: "user", content: "how are you" });

    // The order is the conversation, so a model reads it as one.
    expect(context.getMessages().map((message) => message.content)).toEqual([
      "hello",
      "hi",
      "how are you",
    ]);
  });

  test("keeps the system prompt ahead of what is added later", () => {
    const context = new LLMContext("You are helpful.");
    context.addMessage({ role: "user", content: "hello" });

    expect(context.getMessages().map((message) => message.role)).toEqual(["system", "user"]);
  });

  test("reports how many messages it holds", () => {
    const context = new LLMContext("sys");
    context.addMessage({ role: "user", content: "hello" });

    expect(context.length).toBe(2);
  });

  test("returns a copy, so a caller cannot add to the history through it", () => {
    const context = new LLMContext();
    context.addMessage({ role: "user", content: "hello" });

    const messages = context.getMessages() as { role: string; content: string }[];
    messages.push({ role: "user", content: "sneaked in" });

    expect(context.length).toBe(1);
    expect(context.getMessages().map((message) => message.content)).toEqual(["hello"]);
  });

  test("gives a fresh copy on every call", () => {
    const context = new LLMContext();
    context.addMessage({ role: "user", content: "hello" });

    // A list held earlier must not change when the context does.
    const before = context.getMessages();
    context.addMessage({ role: "assistant", content: "hi" });

    expect(before).toHaveLength(1);
    expect(context.getMessages()).toHaveLength(2);
  });

  test("clears every message, including the system prompt", () => {
    const context = new LLMContext("sys");
    context.addMessage({ role: "user", content: "hello" });

    context.clear();

    expect(context.getMessages()).toEqual([]);
    expect(context.length).toBe(0);
  });

  test("accepts messages again after clearing", () => {
    const context = new LLMContext("sys");
    context.clear();
    context.addMessage({ role: "user", content: "a new conversation" });

    expect(context.getMessages()).toEqual([{ role: "user", content: "a new conversation" }]);
  });
});
