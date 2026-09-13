/**
 * The Foundry globals the pure layers touch, installed before any test's imports resolve
 * (`setupFiles` in vitest.config.mjs).
 *
 * The data layer is written to be testable without Foundry: resolvers are injected, and the
 * few globals that do leak in are the ones below. Anything a test needs to *vary* — the
 * currency table, a setting — it overrides in the test itself; these are only the defaults, so
 * a test that forgets to stub something gets sane behaviour rather than a TypeError from
 * fifteen frames down.
 */

/** dnd5e's standard currency table: units of each denomination per 1 gp. */
const CURRENCIES = {
  pp: { label: "Platinum", abbreviation: "pp", conversion: 0.1 },
  gp: { label: "Gold", abbreviation: "gp", conversion: 1 },
  ep: { label: "Electrum", abbreviation: "ep", conversion: 2 },
  sp: { label: "Silver", abbreviation: "sp", conversion: 10 },
  cp: { label: "Copper", abbreviation: "cp", conversion: 100 }
};

globalThis.CONFIG = {
  DND5E: {
    currencies: CURRENCIES,
    itemRarity: {
      common: "Common",
      uncommon: "Uncommon",
      rare: "Rare",
      veryRare: "Very Rare",
      legendary: "Legendary",
      artifact: "Artifact"
    }
  }
};

globalThis.CONST = {
  USER_ROLES: { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 },
  DOCUMENT_OWNERSHIP_LEVELS: { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 }
};

/**
 * `game.settings.get` throws on an unregistered key in the real thing, and `config.mjs#setting`
 * relies on that to fall back to its defaults. The shim keeps that contract: a key nothing has
 * stubbed throws, exactly as it would in a world where the setting is not registered yet.
 */
const settingStore = new Map();

globalThis.game = {
  settings: {
    get(namespace, key) {
      const id = `${namespace}.${key}`;
      if ( !settingStore.has(id) ) throw new Error(`"${id}" is not a registered game setting`);
      return settingStore.get(id);
    },
    set(namespace, key, value) {
      settingStore.set(`${namespace}.${key}`, value);
      return Promise.resolve(value);
    }
  },
  i18n: {
    lang: "en",
    // Tests assert on behaviour, not on copy, so the key is a perfectly good stand-in for the
    // string — and it makes a missing-key bug obvious rather than invisible.
    localize: key => key,
    format: (key, data) => `${key}:${JSON.stringify(data)}`
  },
  user: { isGM: true, id: "test-user" },
  users: [],
  time: { worldTime: 0 }
};

/** Let a test seed or clear settings without reaching into the closure above. */
globalThis.__setSetting = (namespace, key, value) => settingStore.set(`${namespace}.${key}`, value);
globalThis.__clearSettings = () => settingStore.clear();

/** Hooks are recorded rather than dispatched, so a test can assert what was fired. */
globalThis.__firedHooks = [];

globalThis.Hooks = {
  callAll(hook, ...args) {
    globalThis.__firedHooks.push({ hook, args, cancellable: false });
    return true;
  },
  call(hook, ...args) {
    globalThis.__firedHooks.push({ hook, args, cancellable: true });
    return true;
  },
  on() {},
  once() {}
};

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (a, b) => ({ ...a, ...b }),
    randomID: (length = 16) => Array.from(
      { length }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[
        Math.floor(Math.random() * 62)
      ]
    ).join("")
  }
};

globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
