import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_ARCHETYPES, BUILT_IN_PREFIX, SAVED_LIMIT, archetypeFromTrader, archetypeUpdate,
  budgetSummary, deleteArchetype, getArchetype, isBuiltIn, listArchetypes, recipeToGenerator,
  sanitizeArchetype, sanitizeRecipe, saveArchetype, savedArchetypes, validCategory
} from "../scripts/data/archetypes.mjs";

const MODULE = "sogrom-simple-dnd5e-magic-shop";

afterEach(() => globalThis.__clearSettings());

describe("the built-in archetypes", () => {
  it("each survive their own guard unchanged", () => {
    for ( const archetype of BUILT_IN_ARCHETYPES ) {
      expect(sanitizeArchetype(archetype, { builtIn: true })).toEqual({ ...archetype });
    }
  });

  it("carry a built-in id and a localised name and hint", () => {
    for ( const archetype of BUILT_IN_ARCHETYPES ) {
      expect(archetype.id.startsWith(BUILT_IN_PREFIX)).toBe(true);
      expect(archetype.builtIn).toBe(true);
      expect(archetype.name).toMatch(new RegExp(`^${MODULE}\\.archetype\\.builtIn\\.[a-z]+\\.name$`));
      expect(archetype.hint).toMatch(/\.hint$/);
    }
  });

  it("have unique ids", () => {
    const ids = BUILT_IN_ARCHETYPES.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ask for something, and only for categories the generator can match", () => {
    for ( const archetype of BUILT_IN_ARCHETYPES ) {
      expect(budgetSummary(archetype.recipe).length).toBeGreaterThan(0);
      expect(archetype.recipe.categories.every(validCategory)).toBe(true);
    }
  });

  it("never name a compendium, which no world is guaranteed to have", () => {
    for ( const archetype of BUILT_IN_ARCHETYPES ) expect(archetype.recipe.packs).toEqual([]);
  });

  it("all set a price ceiling", () => {
    // Without one, a single click could stock a 20,000 gp staff.
    for ( const archetype of BUILT_IN_ARCHETYPES ) expect(archetype.recipe.maxValueCp).toBeGreaterThan(0);
  });
});

describe("validCategory", () => {
  it("accepts a physical type, with or without a subtype", () => {
    expect(validCategory("weapon")).toBe(true);
    expect(validCategory("equipment:heavy")).toBe(true);
    expect(validCategory("tool:music")).toBe(true);
  });

  it("refuses anything the generator could never match", () => {
    for ( const bad of ["spell", "spell:evocation", "weapon:", "weapon:a:b", "weapon:a b", 7, ""] ) {
      expect(validCategory(bad)).toBe(false);
    }
  });
});

describe("sanitizeRecipe", () => {
  it("guards every part of a recipe", () => {
    const recipe = sanitizeRecipe({
      budget: { rare: 3, legendary: -1, bogus: 9 },
      categories: ["weapon", "weapon", "spell", "loot:gem"],
      maxValueCp: -50,
      packs: ["dnd5e.items", "", 4, "dnd5e.items"]
    });
    expect(recipe.budget.rare).toBe(3);
    expect(recipe.budget.legendary).toBe(0);
    expect(recipe.budget).not.toHaveProperty("bogus");
    expect(recipe.categories).toEqual(["weapon", "loot:gem"]);
    expect(recipe.maxValueCp).toBe(0);
    expect(recipe.packs).toEqual(["dnd5e.items"]);
  });
});

describe("sanitizeArchetype", () => {
  it("refuses one without an id or a name", () => {
    expect(sanitizeArchetype({ id: "x" })).toBeNull();
    expect(sanitizeArchetype({ name: "x" })).toBeNull();
    expect(sanitizeArchetype(null)).toBeNull();
  });

  it("does not let a saved archetype claim to be built in", () => {
    expect(sanitizeArchetype({ id: "mine", name: "Mine", builtIn: true }).builtIn).toBe(false);
    // Nor borrow the prefix, which could shadow a real built-in.
    expect(sanitizeArchetype({ id: `${BUILT_IN_PREFIX}blacksmith`, name: "Fake" })).toBeNull();
  });

  it("keeps packs on a saved archetype and strips them from a built-in", () => {
    const raw = { id: `${BUILT_IN_PREFIX}x`, name: "X", recipe: { packs: ["a.b"] } };
    expect(sanitizeArchetype(raw, { builtIn: true }).recipe.packs).toEqual([]);
    expect(sanitizeArchetype({ ...raw, id: "x" }).recipe.packs).toEqual(["a.b"]);
  });

  it("treats a missing starting attitude as 'leave it alone', and clamps a present one", () => {
    expect(sanitizeArchetype({ id: "a", name: "A" }).startingAttitude).toBeNull();
    expect(sanitizeArchetype({ id: "a", name: "A", startingAttitude: "" }).startingAttitude).toBeNull();
    expect(sanitizeArchetype({ id: "a", name: "A", startingAttitude: 0 }).startingAttitude).toBe(0);
    expect(sanitizeArchetype({ id: "a", name: "A", startingAttitude: 250 }).startingAttitude).toBe(100);
  });
});

describe("archetypeFromTrader", () => {
  it("takes the Trader's setup and the recipe the GM has in front of them", () => {
    const archetype = archetypeFromTrader({
      id: "mine",
      name: " Dockside Fence ",
      data: {
        buyFilter: { allowAll: false, types: ["loot"], rarities: [] },
        startingAttitude: 25,
        restock: { mode: "time", days: 5, lastAt: 999 },
        greeting: "Not here."
      },
      recipe: { budget: { "": 3 }, categories: ["loot:gem"], maxValueCp: 1000, packs: [] }
    });
    expect(archetype).toMatchObject({
      id: "mine", name: "Dockside Fence", builtIn: false, startingAttitude: 25,
      restock: { mode: "time", days: 5 },
      buyFilter: { allowAll: false, types: ["loot"], rarities: [] }
    });
    expect(archetype.recipe.categories).toEqual(["loot:gem"]);
    // A kind of shop, not a particular one.
    expect(archetype).not.toHaveProperty("greeting");
    expect(archetype.restock).not.toHaveProperty("lastAt");
  });
});

describe("archetypeUpdate", () => {
  it("writes dotted paths, so the greeting, attitudes, ledger and restock clock survive", () => {
    const blacksmith = getArchetype(`${BUILT_IN_PREFIX}blacksmith`);
    const update = archetypeUpdate(blacksmith);
    expect(Object.keys(update).sort()).toEqual([
      `flags.${MODULE}.buyFilter`, `flags.${MODULE}.restock.days`, `flags.${MODULE}.restock.mode`
    ]);
    expect(update[`flags.${MODULE}.buyFilter`].types).toEqual(["weapon", "equipment"]);
  });

  it("sets the starting attitude only when the archetype has one", () => {
    const fence = getArchetype(`${BUILT_IN_PREFIX}fence`);
    expect(archetypeUpdate(fence)[`flags.${MODULE}.startingAttitude`]).toBe(30);
  });

  it("is empty for nonsense", () => {
    expect(archetypeUpdate(null)).toEqual({});
  });
});

describe("recipeToGenerator", () => {
  const toParts = cp => ({ value: cp / 100, denomination: "gp" });

  it("primes the generator panel with the recipe", () => {
    const state = recipeToGenerator({
      budget: { common: 2 }, categories: ["weapon"], maxValueCp: 5000, packs: ["p"]
    }, toParts);
    expect(state).toMatchObject({ categories: ["weapon"], packs: ["p"], maxValue: 50, maxDenom: "gp" });
    expect(state.budget.common).toBe(2);
  });

  it("leaves the ceiling blank when there is none", () => {
    expect(recipeToGenerator({}, toParts)).toMatchObject({ maxValue: "", maxDenom: "gp" });
  });
});

describe("the saved archetypes", () => {
  const mine = (id, name) => ({ id, name, recipe: { budget: { common: 1 } } });

  it("start empty, after the built-ins", () => {
    expect(savedArchetypes()).toEqual([]);
    expect(listArchetypes()).toHaveLength(BUILT_IN_ARCHETYPES.length);
  });

  it("save, replace by id, list by name after the built-ins, and delete", async () => {
    await saveArchetype(mine("b", "Zed's"));
    await saveArchetype(mine("a", "Anvil"));
    await saveArchetype(mine("b", "Bellows"));
    const list = listArchetypes();
    expect(list.slice(0, BUILT_IN_ARCHETYPES.length).every(a => a.builtIn)).toBe(true);
    expect(list.slice(BUILT_IN_ARCHETYPES.length).map(a => a.name)).toEqual(["Anvil", "Bellows"]);

    expect(await deleteArchetype("a")).toBe(true);
    expect(await deleteArchetype("a")).toBe(false);
    expect(savedArchetypes().map(a => a.id)).toEqual(["b"]);
  });

  it("refuses to delete a built-in, without treating the attempt as an error", async () => {
    expect(await deleteArchetype(`${BUILT_IN_PREFIX}fence`)).toBe(false);
    expect(isBuiltIn(`${BUILT_IN_PREFIX}fence`)).toBe(true);
  });

  it("refuses a malformed archetype and a full list", async () => {
    await expect(saveArchetype({ name: "No id" })).rejects.toThrow();
    for ( let i = 0; i < SAVED_LIMIT; i++ ) await saveArchetype(mine(`id${i}`, `A${i}`));
    await expect(saveArchetype(mine("one-more", "Too many"))).rejects.toThrow();
    // Replacing an existing one is still allowed at the limit.
    await expect(saveArchetype(mine("id3", "Renamed"))).resolves.toMatchObject({ name: "Renamed" });
  });

  it("heal a hand-edited setting: junk and duplicates dropped", () => {
    globalThis.__setSetting(MODULE, "archetypes", {
      list: [mine("x", "X"), mine("x", "X again"), { id: "", name: "" }, "junk"]
    });
    expect(savedArchetypes().map(a => a.name)).toEqual(["X"]);
  });
});
