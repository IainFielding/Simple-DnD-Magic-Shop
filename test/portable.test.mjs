import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMAT, EXPORT_VERSION, exportFileName, exportItem, exportTrader,
  parseTraderExport
} from "../scripts/data/portable.mjs";

const MODULE = "sogrom-simple-dnd5e-magic-shop";

/** A Trader as `Actor#toObject()` returns it, with a history that must never travel. */
const traderSource = () => ({
  _id: "trader1",
  name: "Brannoc's Forge",
  img: "icons/forge.webp",
  folder: "folder1",
  system: { currency: { pp: 1, gp: 250, ep: 0, sp: 3.7, cp: -2 } },
  flags: {
    [MODULE]: {
      isTrader: true,
      greeting: "Mind the anvil.",
      startingAttitude: 45,
      attitude: { vex: 90 },
      spend: { vex: { lifetimeCp: 50_000 } },
      ledger: [{ id: "x", actorId: "vex" }],
      buyFilter: { allowAll: false, types: ["weapon"], rarities: [] },
      restock: { mode: "time", days: 4, lastAt: 86_400 },
      attitudeGain: { cpPerPoint: 5000, capPerVisit: 3 }
    },
    "another-module": { kept: true }
  },
  items: [
    {
      _id: "item1",
      name: "Longsword",
      type: "weapon",
      folder: null,
      sort: 100,
      ownership: { default: 0 },
      _stats: { compendiumSource: "Compendium.dnd5e.items.Item.abc", createdTime: 1, lastModifiedBy: "gm" },
      system: { quantity: 3, price: { value: 15, denomination: "gp" }, container: "bag1" },
      flags: {
        [MODULE]: { unlimited: false, overrideCp: 1200, revealAt: 60, baseQty: 3, junk: "x" },
        "another-module": { glow: true }
      }
    },
    { _id: "spell1", name: "Fireball", type: "spell", system: {} },
    { _id: "bag1", name: "Backpack", type: "container", system: { quantity: 1 }, flags: {} }
  ]
});

describe("exportItem", () => {
  it("strips this world's bookkeeping and keeps what makes the item that item", () => {
    const item = exportItem(traderSource().items[0]);
    for ( const field of ["_id", "folder", "sort", "ownership"] ) expect(item).not.toHaveProperty(field);
    expect(item._stats).toEqual({ compendiumSource: "Compendium.dnd5e.items.Item.abc" });
    expect(item.system.price).toEqual({ value: 15, denomination: "gp" });
    expect(item.flags["another-module"]).toEqual({ glow: true });
  });

  it("unlinks it from a container whose id will not survive the move", () => {
    expect(exportItem(traderSource().items[0]).system.container).toBeNull();
  });

  it("re-guards our own line settings", () => {
    expect(exportItem(traderSource().items[0]).flags[MODULE]).toEqual({
      unlimited: false, overrideCp: 1200, revealAt: 60, baseQty: 3
    });
  });

  it("refuses anything a Trader cannot stock", () => {
    expect(exportItem(traderSource().items[1])).toBeNull();
    expect(exportItem(null)).toBeNull();
  });

  it("does not modify its input", () => {
    const source = traderSource().items[0];
    exportItem(source);
    expect(source._id).toBe("item1");
    expect(source.system.container).toBe("bag1");
  });
});

describe("exportTrader", () => {
  const file = exportTrader(traderSource(), { moduleVersion: "1.2.0", exportedAt: "2026-09-13T12:00:00Z" });

  it("identifies itself", () => {
    expect(file).toMatchObject({
      format: EXPORT_FORMAT, version: EXPORT_VERSION, moduleVersion: "1.2.0", exportedAt: "2026-09-13T12:00:00Z"
    });
  });

  it("carries who the Trader is and how it trades", () => {
    expect(file.trader).toEqual({
      name: "Brannoc's Forge",
      img: "icons/forge.webp",
      greeting: "Mind the anvil.",
      startingAttitude: 45,
      buyFilter: { allowAll: false, types: ["weapon"], rarities: [] },
      restock: { mode: "time", days: 4 },
      attitudeGain: { cpPerPoint: 5000, capPerVisit: 3 },
      allUnlimited: false,
      noStockLimit: false,
      currency: { pp: 1, gp: 250, ep: 0, sp: 3, cp: 0 }
    });
  });

  it("never carries opinions, spend or the ledger", () => {
    const text = JSON.stringify(file);
    for ( const secret of ["attitude\":{", "lifetimeCp", "ledger", "\"vex\""] ) {
      expect(text).not.toContain(secret);
    }
  });

  it("carries only stockable items, whole", () => {
    expect(file.items.map(i => i.name)).toEqual(["Longsword", "Backpack"]);
  });

  it("is JSON through and through", () => {
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});

describe("parseTraderExport", () => {
  const good = () => exportTrader(traderSource(), { exportedAt: "now" });

  it("round-trips an export, from a string or an object", () => {
    for ( const input of [good(), JSON.stringify(good())] ) {
      const parsed = parseTraderExport(input);
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.trader).toEqual(good().trader);
      expect(parsed.items).toEqual(good().items);
    }
  });

  it("names what is wrong with a file it will not read", () => {
    expect(parseTraderExport("{not json").error).toBe("notJson");
    expect(parseTraderExport({ some: "other file" }).error).toBe("notATrader");
    expect(parseTraderExport({ ...good(), version: 0 }).error).toBe("notATrader");
    expect(parseTraderExport({ ...good(), version: EXPORT_VERSION + 1 }).error).toBe("tooNew");
    expect(parseTraderExport({ ...good(), trader: { name: "  " } }).error).toBe("noName");
  });

  it("guards a hand-edited file rather than trusting it", () => {
    const file = good();
    file.trader.startingAttitude = 900;
    file.trader.restock = { mode: "hourly", days: -1, lastAt: 5 };
    file.trader.currency = { gp: "lots", sp: 12 };
    file.items.push({ name: "Wish", type: "spell" }, { name: "", type: "loot" }, "junk");
    const parsed = parseTraderExport(file);
    expect(parsed.trader.startingAttitude).toBe(100);
    expect(parsed.trader.restock).toEqual({ mode: "manual", days: 7 });
    expect(parsed.trader.currency).toEqual({ pp: 0, gp: 0, ep: 0, sp: 12, cp: 0 });
    expect(parsed.items.map(i => i.name)).toEqual(["Longsword", "Backpack"]);
  });

  it("keeps a missing starting attitude as 'follow the world'", () => {
    const file = good();
    delete file.trader.startingAttitude;
    expect(parseTraderExport(file).trader.startingAttitude).toBeNull();
  });

  it("caps how many lines one file can create", () => {
    const file = good();
    file.items = Array.from({ length: 30 }, (_, i) => ({ name: `Rock ${i}`, type: "loot" }));
    expect(parseTraderExport(file, { limit: 20 }).items).toHaveLength(20);
  });

  it("carries both shelf options, and keeps every line of a Trader with no limit", () => {
    const source = traderSource();
    Object.assign(source.flags[MODULE], { allUnlimited: true, noStockLimit: true });
    const file = exportTrader(source);
    expect(file.trader).toMatchObject({ allUnlimited: true, noStockLimit: true });

    file.items = Array.from({ length: 30 }, (_, i) => ({ name: `Rock ${i}`, type: "loot" }));
    const parsed = parseTraderExport(file, { limit: 20 });
    expect(parsed.trader).toMatchObject({ allUnlimited: true, noStockLimit: true });
    expect(parsed.items).toHaveLength(30);
    expect(parsed.dropped).toBe(0);
  });

  it("reads a missing or malformed shelf option as off", () => {
    const file = good();
    file.trader.allUnlimited = "yes";
    delete file.trader.noStockLimit;
    expect(parseTraderExport(file).trader).toMatchObject({ allUnlimited: false, noStockLimit: false });
  });
});

describe("exportFileName", () => {
  it("makes a Trader's name safe for any file system", () => {
    expect(exportFileName("Brannoc's Forge")).toBe("trader-brannoc-s-forge.json");
    expect(exportFileName("Café Élan")).toBe("trader-cafe-elan.json");
    expect(exportFileName("../../etc/passwd")).toBe("trader-etc-passwd.json");
    expect(exportFileName("")).toBe("trader-unnamed.json");
  });
});
