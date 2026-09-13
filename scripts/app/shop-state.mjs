import { barterBalance, formatCp, priceBasket, totalCp } from "../data/pricing.mjs";
import { categoryTokens } from "../data/generate.mjs";

/**
 * The shop window's working state: what is currently on the counter.
 *
 * Deliberately separate from the window, and deliberately free of Foundry. The staging maths —
 * what a cart costs, whether it is affordable, whether a barter balances — is the part most
 * worth testing and the part a rendering bug must not be able to corrupt, so it lives here as
 * plain data with plain methods over it.
 *
 * ## What it does not do
 *
 * It never writes anything, and it never decides a price. Prices arrive in the context payload
 * from the GM ({@link module:trade/context}) and are used here only to show running totals; the
 * authoritative path recomputes them all from scratch when the trade is confirmed. So a bug in
 * this file can show a player the wrong subtotal, but it cannot make them pay it.
 */
export class ShopState {

  /** The mode toggle. Trade is gold against goods; Barter is goods against goods. */
  mode = "trade";

  /** Staged Trader stock: `itemId -> qty`. What the character is taking. */
  take = new Map();

  /** Staged character gear: `itemId -> qty`. What the character is giving. */
  give = new Map();

  /**
   * Coins the character adds to their side of a barter, by denomination: `{gp: 3, sp: 5}`.
   *
   * Held as the actual coins rather than a copper total, because that is what the player chose
   * and what settlement moves — three platinum pieces offered should leave the purse as three
   * platinum pieces, not as thirty gold the system decided to take instead.
   */
  coins = {};

  /** The staged coins as copper, which is what the barter arithmetic weighs. */
  get goldCp() {
    return totalCp(this.coins);
  }

  /**
   * Stage an amount of coin as plain copper.
   *
   * Kept for callers that think in totals — the API's `barter({goldCp})` and the unit tests. The
   * shop window itself stages real coins through {@link setCoin}.
   */
  set goldCp(cp) {
    const value = Math.max(0, Math.round(Number(cp) || 0));
    this.coins = value > 0 ? { cp: value } : {};
  }

  /**
   * Stage a number of one denomination, clamped to what the character actually holds of it.
   *
   * Clamped here rather than only at settlement, so the box a player is typing in cannot show an
   * offer the purse cannot back — the GM re-checks anyway, but a refusal after pressing Confirm
   * is a worse way to find out than a box that will not go past what you have.
   * @param {string} denomination
   * @param {number} amount
   * @returns {number}  The amount actually staged.
   */
  setCoin(denomination, amount) {
    const held = this.purse?.currency?.[denomination];
    const ceiling = held === undefined ? Infinity : Math.max(0, Math.floor(Number(held) || 0));
    const value = Math.max(0, Math.min(ceiling, Math.floor(Number(amount) || 0)));
    const next = { ...this.coins };
    if ( value > 0 ) next[denomination] = value;
    else delete next[denomination];
    this.coins = next;
    return value;
  }

  /** The last context payload from the GM. */
  context = null;

  /**
   * The purse this deal pays from: a Group's when the player chose one, otherwise the
   * character's own. Everything that asks "can they afford it" reads this, not `context.actor`.
   *
   * Falls back to the actor for a payload built before purses were part of it — a test fixture,
   * or a GM client still running an older copy of the module mid-update.
   * @type {{purseCp: number, currency?: object}|null}
   */
  get purse() {
    return this.context?.purse ?? this.context?.actor ?? null;
  }

  /** Per-panel search needles, applied client-side so typing never triggers a re-render. */
  search = { stock: "", pack: "" };

  /**
   * Per-panel item type filter: a category token (`"weapon"`, `"equipment:heavy"`) or `""` for
   * everything. Kept here beside the search so both survive a re-render.
   */
  category = { stock: "", pack: "" };

  /* -------------------------------------------- */

  /**
   * Adopt a fresh context payload, dropping anything staged that no longer exists.
   *
   * A GM editing the Trader while a player has the shop open is the normal case this handles:
   * the stock list is rebuilt, and a staged line whose item has gone — or whose quantity has
   * dropped below what was staged — is trimmed rather than left to fail at confirmation.
   * @param {object} context
   */
  adopt(context) {
    this.context = context;
    const stock = new Map(context.stock.map(line => [line.id, line]));
    const pack = new Map(context.pack.map(line => [line.id, line]));

    for ( const [id, qty] of [...this.take] ) {
      const line = stock.get(id);
      if ( !line ) this.take.delete(id);
      else if ( !line.unlimited && qty > line.qty ) this.take.set(id, line.qty);
    }
    for ( const [id, qty] of [...this.give] ) {
      const line = pack.get(id);
      if ( !line || line.blocked ) this.give.delete(id);
      else if ( qty > line.qty ) this.give.set(id, line.qty);
    }
    // Coin too: a character who spent gold elsewhere cannot still be offering it here.
    for ( const [denomination, amount] of Object.entries(this.coins) ) {
      this.setCoin(denomination, amount);
    }
    // A type filter for a category the panel no longer holds — the last weapon sold — would
    // leave the player looking at an empty panel with a dropdown that no longer offers the
    // choice that emptied it. Fall back to showing everything.
    for ( const key of ["stock", "pack"] ) {
      const token = this.category[key];
      if ( token && !context[key].some(line => categoryTokens(line).includes(token)) ) {
        this.category[key] = "";
      }
    }
  }

  /** Clear the counter, keeping the mode and the context. */
  clear() {
    this.take.clear();
    this.give.clear();
    this.coins = {};
  }

  /** Whether anything is staged at all. */
  get empty() {
    return !this.take.size && !this.give.size && !this.goldCp;
  }

  /* -------------------------------------------- */
  /*  Staging                                     */
  /* -------------------------------------------- */

  /**
   * Add to or remove from a side of the counter.
   *
   * Clamped to what is actually available, so the UI cannot stage eleven of a stock of ten and
   * discover the problem only on confirmation. An unlimited line has no ceiling.
   * @param {"take"|"give"} side
   * @param {string} id
   * @param {number} delta
   * @returns {boolean}  Whether anything changed, so the caller can skip a pointless re-render.
   */
  stage(side, id, delta) {
    const line = this.#line(side, id);
    if ( !line || line.blocked ) return false;

    const map = this[side];
    const ceiling = line.unlimited ? Infinity : line.qty;
    const current = map.get(id) ?? 0;
    const next = Math.max(0, Math.min(ceiling, current + delta));
    if ( next === current ) return false;

    if ( next === 0 ) map.delete(id);
    else map.set(id, next);
    return true;
  }

  /** The context line behind a staged id. */
  #line(side, id) {
    const source = side === "take" ? this.context?.stock : this.context?.pack;
    return source?.find(line => line.id === id);
  }

  /** How many of a line are staged, for the tile badge. */
  staged(side, id) {
    return this[side].get(id) ?? 0;
  }

  /* -------------------------------------------- */
  /*  Totals                                      */
  /* -------------------------------------------- */

  /** Staged lines as the pricing helpers expect them: `{id, valueCp, qty}`. */
  #basket(side) {
    const source = side === "take" ? this.context?.stock ?? [] : this.context?.pack ?? [];
    const map = this[side];
    return source
      .filter(line => map.has(line.id))
      .map(line => ({ id: line.id, valueCp: line.valueCp, qty: map.get(line.id) }));
  }

  /**
   * What the counter currently comes to.
   *
   * In **trade** mode the two sides are independent: buying costs, selling pays, and the net is
   * what changes hands. A player may do both in one confirmation — selling the old sword to
   * help pay for the new one is the single most common thing anyone does in a shop, and making
   * them do it as two transactions would be worse in every way.
   *
   * In **barter** mode the sides are weighed against each other and the Trader either accepts
   * or does not.
   * @returns {object}
   */
  totals() {
    const multipliers = this.context?.multipliers ?? { buy: 1, sell: 0.5 };

    if ( this.mode === "barter" ) {
      const result = barterBalance({
        take: this.#basket("take"),
        give: this.#basket("give"),
        goldCp: this.goldCp,
        multipliers
      });
      return {
        mode: "barter",
        askCp: result.askCp,
        offerCp: result.offerCp,
        balanceCp: result.balanceCp,
        accepted: result.accepted,
        ask: formatCp(result.askCp),
        offer: formatCp(result.offerCp),
        balance: formatCp(Math.abs(result.balanceCp)),
        // A barter is affordable when the character actually holds the coins they are adding —
        // denomination by denomination where the purse is known, since 50 gp does not cover
        // an offer of 3 platinum pieces the character does not have.
        affordable: this.#coinsHeld()
      };
    }

    const buying = priceBasket(this.#basket("take"), multipliers.buy);
    const selling = priceBasket(this.#basket("give"), multipliers.sell);
    const netCp = buying.totalCp - selling.totalCp;

    return {
      mode: "trade",
      costCp: buying.totalCp,
      creditCp: selling.totalCp,
      netCp,
      cost: formatCp(buying.totalCp),
      credit: formatCp(selling.totalCp),
      net: formatCp(Math.abs(netCp)),
      owed: netCp > 0,
      // The sale is settled in the same breath as the purchase, so its proceeds count toward
      // paying for it — otherwise a player with 10 gp could not trade a 100 gp sword for a
      // 90 gp shield, which is a perfectly ordinary thing to want to do.
      affordable: netCp <= (this.purse?.purseCp ?? 0),
      accepted: true
    };
  }

  /**
   * The staged lines as a trade intent: **ids and quantities only**.
   *
   * This is the whole payload that crosses back to the GM. No prices, no totals, no
   * multipliers — everything the GM needs it already has or will re-derive, and anything else
   * would be a number a tampered client could choose.
   * `coins` is a *quantity* too — how many of each coin — not a price, so it belongs here by the
   * same rule as item counts. The GM checks each against the purse before moving any.
   * @returns {{mode: string, buy: object[], sell: object[], goldCp: number, coins: object|null}}
   */
  intent() {
    const barter = this.mode === "barter";
    return {
      mode: this.mode,
      buy: [...this.take].map(([id, qty]) => ({ id, qty })),
      sell: [...this.give].map(([id, qty]) => ({ id, qty })),
      goldCp: barter ? this.goldCp : 0,
      coins: barter && this.goldCp > 0 ? { ...this.coins } : null
    };
  }

  /** Whether every staged coin is actually in the character's purse. */
  #coinsHeld() {
    const currency = this.purse?.currency;
    // No per-denomination purse in the context (an older payload, or a test fixture): fall back
    // to comparing totals, which is still never wrong in the unsafe direction.
    if ( !currency ) return this.goldCp <= (this.purse?.purseCp ?? 0);
    return Object.entries(this.coins).every(([d, n]) => n <= (Number(currency[d]) || 0));
  }
}
