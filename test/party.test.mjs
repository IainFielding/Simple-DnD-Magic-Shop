import { describe, expect, it } from "vitest";
import { canPayFrom, isMember, memberIds, payableGroups } from "../scripts/data/party.mjs";

const vex = { id: "vex", name: "Vex" };
const player = { id: "p1", isGM: false };
const gm = { id: "gm", isGM: true };

/** A Group actor with the given members and a set of users who own it. */
const group = ({ id = "party", name = "The Company", members = ["vex"], owners = ["p1"], type = "group" } = {}) => ({
  id,
  name,
  type,
  system: { members: members.map(m => ({ actor: typeof m === "string" ? { id: m } : m })) },
  testUserPermission: (user, level) => level === "OWNER" && owners.includes(user?.id)
});

describe("memberIds", () => {
  it("reads prepared members, whose actor is a document", () => {
    expect([...memberIds(group({ members: ["vex", "thog"] }))]).toEqual(["vex", "thog"]);
  });

  it("reads source members, whose actor is a bare id", () => {
    const g = { system: { members: [{ actor: "vex" }, { actor: null }] } };
    expect([...memberIds(g)]).toEqual(["vex"]);
  });

  it("prefers the ids Set dnd5e hangs off prepared data", () => {
    const members = [];
    Object.defineProperty(members, "ids", { value: new Set(["vex"]) });
    expect(isMember({ system: { members } }, "vex")).toBe(true);
  });

  it("is empty for anything without members", () => {
    expect(memberIds(null).size).toBe(0);
    expect(memberIds({ system: {} }).size).toBe(0);
  });
});

describe("canPayFrom", () => {
  it("allows a member whose player owns the Group", () => {
    expect(canPayFrom({ group: group(), actor: vex, user: player })).toBe(true);
  });

  it("refuses a member whose player does not own the Group", () => {
    // Membership alone is not the right to spend the fund — the GM grants that with ownership.
    expect(canPayFrom({ group: group({ owners: [] }), actor: vex, user: player })).toBe(false);
  });

  it("refuses an owner whose character is not a member", () => {
    expect(canPayFrom({ group: group({ members: ["thog"] }), actor: vex, user: player })).toBe(false);
  });

  it("lets a GM use any Group the character belongs to, and still no other", () => {
    expect(canPayFrom({ group: group({ owners: [] }), actor: vex, user: gm })).toBe(true);
    expect(canPayFrom({ group: group({ members: [] }), actor: vex, user: gm })).toBe(false);
  });

  it("refuses anything that is not a Group", () => {
    expect(canPayFrom({ group: group({ type: "npc" }), actor: vex, user: gm })).toBe(false);
    expect(canPayFrom({ group: null, actor: vex, user: gm })).toBe(false);
    expect(canPayFrom({ group: group(), actor: null, user: gm })).toBe(false);
  });
});

describe("payableGroups", () => {
  it("lists only the Groups this user may pay from, by name", () => {
    const actors = [
      group({ id: "b", name: "Zephyr Company" }),
      group({ id: "a", name: "Ashen Hands" }),
      group({ id: "c", name: "Not Ours", owners: [] }),
      { id: "npc", type: "npc", name: "Shopkeeper" }
    ];
    expect(payableGroups(actors, vex, player).map(g => g.id)).toEqual(["a", "b"]);
  });
});
