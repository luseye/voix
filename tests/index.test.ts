import { describe, expect, test } from "bun:test";

import { VERSION, WebSocketInput } from "../src/index.ts";

describe("package", () => {
  test("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });

  test("exposes the WebSocket input transport", () => {
    expect(new WebSocketInput(16000)).toBeInstanceOf(WebSocketInput);
  });
});
