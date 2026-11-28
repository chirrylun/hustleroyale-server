import { describe, expect, it } from "vitest";
import { ChatLimiter, cleanChat, MAX_CHAT } from "./chat.js";

describe("chat text", () => {
  it("strips control characters and line breaks and squeezes spaces", () => {
    expect(cleanChat("  hi\n\nthere\t  friend \u0007 ")).toBe("hi there friend");
  });
  it("cuts long lines and returns empty for blanks", () => {
    expect(cleanChat("a".repeat(500))).toHaveLength(MAX_CHAT);
    expect(cleanChat(" \n\t ")).toBe("");
  });
});

describe("chat limiter", () => {
  it("allows a burst, then asks to slow down until the window passes", () => {
    const l = new ChatLimiter(3, 1000, 0);
    expect([l.allow("a", 0), l.allow("b", 10), l.allow("c", 20), l.allow("d", 30)]).toEqual(["ok", "ok", "ok", "slow"]);
    expect(l.allow("e", 1100)).toBe("ok");
  });
  it("drops the same line sent twice quickly", () => {
    const l = new ChatLimiter(5, 8000, 5000);
    expect(l.allow("hello", 0)).toBe("ok");
    expect(l.allow("hello", 1000)).toBe("dup");
    expect(l.allow("hello", 6000)).toBe("ok");
  });
});
