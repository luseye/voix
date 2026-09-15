/**
 * Where the client dials.
 *
 * The protocol is the part a browser enforces: an `https` page that opens a
 * `ws:` socket is blocked as mixed content, and the failure is indistinguishable
 * from a server that is not running. These pin the derivation so it cannot be
 * broken silently.
 */

import { describe, expect, test } from "bun:test";

import { sessionUrl, VOICE_PATH } from "../examples/session-url.ts";

describe("sessionUrl", () => {
  test("keeps the page's host and port", () => {
    expect(sessionUrl("http://localhost:8080/")).toBe("ws://localhost:8080/voice");
    expect(sessionUrl("http://192.168.1.20:9000/")).toBe("ws://192.168.1.20:9000/voice");
  });

  test("switches an https page to a secure socket", () => {
    // A `ws:` socket from an `https:` page is blocked as mixed content, so a
    // deployed page has to upgrade its protocol.
    expect(sessionUrl("https://voice.example.com/")).toBe("wss://voice.example.com/voice");
  });

  test("ignores the page's path and query", () => {
    // The session lives at a fixed path, whatever URL the page was opened at.
    expect(sessionUrl("http://localhost:8080/index.html?x=1#top")).toBe(
      "ws://localhost:8080/voice",
    );
  });

  test("uses the path the server runs sessions at", () => {
    expect(sessionUrl("http://localhost:8080/")).toBe(`ws://localhost:8080${VOICE_PATH}`);
  });
});
