import { describe, expect, it } from "vitest";
import { serialised } from "../scripts/data/serial.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("serialised", () => {
  it("never lets a second task start before the first has finished", async () => {
    const log = [];
    const task = name => async () => {
      log.push(`${name} start`);
      await tick();
      await tick();
      log.push(`${name} end`);
      return name;
    };
    const results = await Promise.all([serialised(task("a")), serialised(task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("closes the read-then-write race it exists for", async () => {
    // Two buyers, one item. Each reads the shelf, waits (a document write), then takes it.
    let shelf = 1;
    const buy = () => serialised(async () => {
      if ( shelf < 1 ) throw new Error("sold out");
      await tick();
      shelf -= 1;
      return "bought";
    });
    const outcomes = await Promise.allSettled([buy(), buy()]);
    expect(outcomes.map(o => o.status)).toEqual(["fulfilled", "rejected"]);
    expect(shelf).toBe(0);
  });

  it("carries on after a task fails", async () => {
    await expect(serialised(async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    await expect(serialised(async () => "next")).resolves.toBe("next");
  });
});
