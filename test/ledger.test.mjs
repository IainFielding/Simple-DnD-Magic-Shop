import { describe, expect, it } from "vitest";
import {
  LEDGER_LIMIT, appendEntry, entriesFor, ledgerCharacters, ledgerTotals, makeEntry,
  sanitizeEntry, sanitizeLedger
} from "../scripts/data/ledger.mjs";

/** A settled receipt as `applyWrites` returns it, with just the fields the ledger reads. */
const receipt = (overrides = {}) => ({
  mode: "trade",
  actor: { id: "vex", name: "Vex" },
  payer: { id: "vex", name: "Vex" },
  bought: [{ name: "Longsword", qty: 1, lineCp: 1650, uuid: "Compendium.x.Item.a" }],
  sold: [{ name: "Dagger", qty: 2, lineCp: 180, uuid: "" }],
  costCp: 1650,
  creditCp: 180,
  netCp: 1470,
  attitudeGained: 1,
  attitudeNow: 51,
  ...overrides
});

const entry = (id, worldTime, overrides = {}) => makeEntry({
  id, receipt: receipt(overrides), worldTime, realTime: 1_000 + worldTime, userName: "Player"
});

describe("makeEntry", () => {
  it("records the figures and the names, never the documents", () => {
    const e = entry("a", 10);
    expect(e).toMatchObject({
      id: "a", worldTime: 10, mode: "trade", actorId: "vex", actorName: "Vex",
      userName: "Player", costCp: 1650, creditCp: 180, netCp: 1470,
      attitudeGained: 1, attitudeNow: 51
    });
    expect(e.bought).toEqual([{ name: "Longsword", qty: 1, lineCp: 1650, uuid: "Compendium.x.Item.a" }]);
    // A plain object all the way down: it is stored in a flag and sent over a socket.
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });

  it("names a Group that paid, and says nothing when the character paid for themselves", () => {
    expect(entry("a", 0).payerId).toBeNull();
    expect(entry("a", 0).payerName).toBeNull();
    const group = entry("b", 0, { payer: { id: "party", name: "The Company" } });
    expect(group.payerId).toBe("party");
    expect(group.payerName).toBe("The Company");
  });

  it("keeps a negative net, which is a character being paid", () => {
    expect(entry("a", 0, { netCp: -300 }).netCp).toBe(-300);
  });
});

describe("sanitizeEntry", () => {
  it("drops something that is not recognisably an entry", () => {
    expect(sanitizeEntry(null)).toBeNull();
    expect(sanitizeEntry({ actorId: "vex" })).toBeNull();
    expect(sanitizeEntry({ id: "a" })).toBeNull();
  });

  it("guards every field of a hand-edited entry", () => {
    const e = sanitizeEntry({
      id: "a", actorId: "vex", mode: "haggle", costCp: -5, attitudeNow: 900,
      bought: [{ name: "", qty: 1 }, { name: "Rope", qty: "3", lineCp: 30 }, "junk"]
    });
    expect(e.mode).toBe("trade");
    expect(e.costCp).toBe(0);
    expect(e.attitudeNow).toBe(100);
    expect(e.bought).toEqual([{ name: "Rope", qty: 3, lineCp: 30, uuid: "" }]);
    expect(e.payerName).toBeNull();
  });
});

describe("sanitizeLedger and appendEntry", () => {
  it("reads newest first whatever order it was stored in", () => {
    const ledger = sanitizeLedger([entry("old", 10), entry("new", 500), entry("mid", 200)]);
    expect(ledger.map(e => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks a tie on the game clock with real time, since a shopping trip rarely moves it", () => {
    const first = makeEntry({ id: "first", receipt: receipt(), worldTime: 0, realTime: 1 });
    const second = makeEntry({ id: "second", receipt: receipt(), worldTime: 0, realTime: 2 });
    expect(sanitizeLedger([first, second]).map(e => e.id)).toEqual(["second", "first"]);
  });

  it("puts a new entry at the front and leaves the input alone", () => {
    const before = [entry("a", 1)];
    const after = appendEntry(before, entry("b", 2));
    expect(after.map(e => e.id)).toEqual(["b", "a"]);
    expect(before).toHaveLength(1);
  });

  it("drops the oldest past the limit", () => {
    let ledger = [];
    for ( let i = 0; i < LEDGER_LIMIT + 5; i++ ) ledger = appendEntry(ledger, entry(`e${i}`, i));
    expect(ledger).toHaveLength(LEDGER_LIMIT);
    expect(ledger[0].id).toBe(`e${LEDGER_LIMIT + 4}`);
    expect(ledger.some(e => e.id === "e0")).toBe(false);
  });

  it("does not record the same entry twice", () => {
    const e = entry("a", 1);
    expect(appendEntry(appendEntry([], e), e)).toHaveLength(1);
  });

  it("survives a flag that is not a list at all", () => {
    expect(sanitizeLedger({ nope: true })).toEqual([]);
    expect(appendEntry("junk", entry("a", 1))).toHaveLength(1);
  });
});

describe("reading a ledger", () => {
  const ledger = [
    entry("1", 1),
    entry("2", 2, { actor: { id: "thog", name: "Thog" } }),
    entry("3", 3),
    entry("4", 4, { actor: { id: "vex", name: "Vex the Bold" } })
  ];

  it("filters to one character, newest first", () => {
    expect(entriesFor(ledger, "vex").map(e => e.id)).toEqual(["4", "3", "1"]);
    expect(entriesFor(ledger, "vex", 2).map(e => e.id)).toEqual(["4", "3"]);
    expect(entriesFor(ledger, "")).toEqual([]);
  });

  it("lists each character once, under the name they last traded as", () => {
    expect(ledgerCharacters(ledger)).toEqual([
      { id: "thog", name: "Thog", count: 1 },
      { id: "vex", name: "Vex the Bold", count: 3 }
    ]);
  });

  it("totals the coin that changed hands and the goods from the Trader's side", () => {
    const totals = ledgerTotals(sanitizeLedger([
      entry("a", 1),
      entry("b", 2, { netCp: -200, bought: [], sold: [{ name: "Gem", qty: 4, lineCp: 200 }] })
    ]));
    expect(totals).toEqual({ trades: 2, takenCp: 1470, paidCp: 200, itemsSold: 1, itemsBought: 6 });
  });
});
