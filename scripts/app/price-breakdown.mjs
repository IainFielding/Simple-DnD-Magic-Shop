import { formatCp } from "../data/pricing.mjs";

/**
 * The price breakdown a player sees on hover: where a price comes from, term by term.
 *
 * The favour model has exactly two inputs a player can do something about — their Charisma and the
 * Trader's opinion of them — and the whole point of showing them is that a player who understands
 * why the sword costs 43 gold will roleplay differently from one who suspects the module of making
 * numbers up.
 *
 * Rendered as dnd5e's own attribution table (the one its sheets use for armour class and the like),
 * so it reads as part of the system rather than as ours. Built here as a string rather than through
 * a template: it is rendered for every staged line on every refresh, and a template render is an
 * async round trip for a handful of table cells.
 *
 * Pure: every word arrives already localised through `labels`, so the tests need no i18n.
 */

/** Escape text for HTML, since item names and labels land inside markup. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

/** A favour contribution as a signed figure: "+0.30", "−0.12", "0.00". */
export function signed(value) {
  const n = Number(value) || 0;
  const text = Math.abs(n).toFixed(2);
  if ( Math.abs(n) < 0.005 ) return "0.00";
  return n > 0 ? `+${text}` : `−${text}`;
}

/** A multiplier as it is written on the shop's rate line: "×0.86". */
export function times(value) {
  return `×${(Number(value) || 0).toFixed(2)}`;
}

/**
 * An attribution table.
 * @param {object} params
 * @param {string} [params.caption]
 * @param {{value: string, label: string}[]} params.rows
 * @param {{value: string, label: string}} [params.total]
 * @returns {string}
 */
export function attributionTable({ caption = "", rows = [], total = null }) {
  const cell = (value, label, cls = "") => `<tr${cls ? ` class="${cls}"` : ""}>`
    + `<td class="attribution-value">${escapeHtml(value)}</td>`
    + `<td class="attribution-label">${escapeHtml(label)}</td></tr>`;
  return "<table>"
    + (caption ? `<caption>${escapeHtml(caption)}</caption>` : "")
    + rows.map(r => cell(r.value, r.label)).join("")
    + (total ? cell(total.value, total.label, "total") : "")
    + "</table>";
}

/**
 * The favour rows: Charisma, attitude, and a note when a house rule has changed the result.
 * @param {object} pricing  The context payload's `pricing`.
 * @param {object} labels
 * @returns {{value: string, label: string}[]}
 */
function favourRows(pricing, labels) {
  const rows = [
    { value: signed(pricing.chaFavour), label: labels.charisma(pricing.chaMod) },
    { value: signed(pricing.attitudeFavour), label: labels.attitude(pricing.attitude, pricing.tier) }
  ];
  if ( pricing.adjusted ) rows.push({ value: "", label: labels.adjusted });
  return rows;
}

/**
 * The breakdown on the shop's rate line: where this character's favour comes from, and what it
 * makes each side pay.
 * @param {object} pricing  The context payload's `pricing`.
 * @param {object} labels   Localised labels and label functions, see the shop app.
 * @returns {string}
 */
export function rateBreakdown(pricing, labels) {
  if ( !pricing ) return "";
  return attributionTable({
    caption: labels.caption,
    rows: [
      ...favourRows(pricing, labels),
      { value: times(pricing.buy), label: labels.youPay },
      { value: times(pricing.sell), label: labels.theyPay }
    ],
    total: { value: signed(pricing.total), label: labels.favour }
  });
}

/**
 * The breakdown on one staged line: list value, what moved it, and the price per item.
 * @param {object} params
 * @param {object} params.line     A context stock or pack line (`valueCp`, `fixed`, `buyCp`/`sellCp`).
 * @param {"take"|"give"} params.side
 * @param {object} params.pricing  The context payload's `pricing`.
 * @param {object} params.labels
 * @returns {string}
 */
export function lineBreakdown({ line, side, pricing, labels }) {
  if ( !line || !pricing ) return "";
  const unitCp = side === "take" ? line.buyCp : line.sellCp;
  const rows = [{ value: formatCp(line.valueCp), label: labels.listValue }];
  if ( line.fixed ) {
    rows.push({ value: times(1), label: labels.fullValue });
  } else {
    rows.push(...favourRows(pricing, labels));
    rows.push({
      value: times(side === "take" ? pricing.buy : pricing.sell),
      label: side === "take" ? labels.youPay : labels.theyPay
    });
  }
  return attributionTable({ rows, total: { value: formatCp(unitCp), label: labels.each } });
}
