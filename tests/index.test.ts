import { describe, expect, test } from "bun:test";

import { VERSION } from "../src/index.ts";

describe("package", () => {
  test("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
