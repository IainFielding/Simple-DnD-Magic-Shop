import { describe, expect, it } from "vitest";
import { summarizePayload } from "../scripts/config.mjs";

describe("summarizePayload", () => {
  it("keeps plain values as they are", () => {
    expect(summarizePayload({ traderId: "abc", qty: 3, ok: true, none: null }))
      .toEqual({ traderId: "abc", qty: 3, ok: true, none: null });
  });

  it("reduces documents, windows, arrays and objects to text", () => {
    class ShopApp {
      id = "shop-1";
      render() {}
    }
    const summary = summarizePayload({
      trader: { documentName: "Actor", name: "Mirela", id: "t1" },
      app: new ShopApp(),
      lines: [1, 2, 3],
      totals: { buy: 1, sell: 2 },
      callback: () => {}
    });
    expect(summary).toEqual({
      trader: 'Actor "Mirela" (t1)',
      app: "ShopApp #shop-1",
      lines: "[3 item(s)]",
      totals: "{buy, sell}",
      callback: "[function]"
    });
  });

  it("holds no reference to anything it was given", () => {
    const summary = summarizePayload({ app: { render() {}, id: "x" }, deep: { a: { b: 1 } } });
    for ( const value of Object.values(summary) ) expect(typeof value).not.toBe("object");
  });

  it("passes a missing payload through", () => {
    expect(summarizePayload(undefined)).toBeUndefined();
  });
});
