import { describe, expect, it } from "vitest";
import { ClaimBook, claimKey, winner } from "../scripts/trade/claim.mjs";

describe("winner", () => {
  it("is the lowest id, compared as strings", () => {
    expect(winner(["m2", "a9", "zz"])).toBe("a9");
  });

  it("ignores junk and is null for nobody", () => {
    expect(winner(["", null, "b"])).toBe("b");
    expect(winner([])).toBe(null);
    expect(winner(undefined)).toBe(null);
  });
});

describe("ClaimBook", () => {
  it("elects exactly one of two tabs claiming the same request", () => {
    const book = new ClaimBook();
    book.record("trade:1", "tabB", 0);
    book.record("trade:1", "tabA", 0);
    expect(book.won("trade:1", "tabA")).toBe(true);
    expect(book.won("trade:1", "tabB")).toBe(false);
  });

  it("lets a lone claimant win", () => {
    const book = new ClaimBook();
    book.record("trade:2", "tabB", 0);
    expect(book.won("trade:2", "tabB")).toBe(true);
  });

  it("never lets a tab that did not claim win", () => {
    // Fails toward silence: a trade that times out is recoverable, one settled twice is not.
    const book = new ClaimBook();
    book.record("trade:3", "tabB", 0);
    expect(book.won("trade:3", "tabA")).toBe(false);
    expect(book.won("nothing", "tabA")).toBe(false);
  });

  it("keeps requests apart", () => {
    const book = new ClaimBook();
    book.record("trade:4", "tabA", 0);
    book.record("trade:5", "tabB", 0);
    expect(book.won("trade:5", "tabB")).toBe(true);
  });

  it("forgets old claims", () => {
    const book = new ClaimBook();
    book.record("old", "tabA", 0);
    book.prune(60_000);
    expect(book.size).toBe(0);
  });
});

describe("claimKey", () => {
  it("uses the request id when there is one", () => {
    expect(claimKey({ requestId: "abc", buy: [] }, { id: "u1" }, "trade")).toBe("trade:abc");
  });

  it("falls back to the user and the payload, which every tab computes identically", () => {
    const a = claimKey({ buy: [{ id: "x", qty: 1 }] }, { id: "u1" }, "trade");
    const b = claimKey({ buy: [{ id: "x", qty: 1 }] }, { id: "u1" }, "trade");
    expect(a).toBe(b);
    expect(claimKey({ buy: [] }, { id: "u2" }, "trade")).not.toBe(a);
  });
});
