// Helpers the display-layer cases read a rendered window with: the markup of
// one item, entry or result, the value of one attribute, and the text a reader
// sees.

/** visibleText is what a reader reads: tags removed, entities decoded. */
export function visibleText(html) {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** itemMarkup returns the markup of one rendered item, by its data-item id. */
export function itemMarkup(html, id) {
  return blockMarkup(html, `data-item="${id}"`, "section");
}

/** entryMarkup returns the markup of one rendered entry form. */
export function entryMarkup(html, id) {
  return blockMarkup(html, `data-entry="${id}"`, "form");
}

/** policyMarkup returns the markup of one rendered policy article. */
export function policyMarkup(html, id) {
  return blockMarkup(html, `data-policy="${id}"`, "article");
}

/** restoreMarkup returns the markup of one rendered restore result card. */
export function restoreMarkup(html, id) {
  return blockMarkup(html, `data-restore="${id}"`, "article");
}

/** metricsMarkup returns one side of a restore's four-item comparison. */
export function metricsMarkup(html, side) {
  return blockMarkup(html, `data-metrics="${side}"`, "section");
}

/**
 * formValues reads one rendered form the way the window's submit handler does:
 * every named control's current value, a checked box as `on`. A select answers
 * the option marked selected.
 */
export function formValues(markup) {
  const values = new Map();
  const source = String(markup);
  for (const match of source.matchAll(/<input\b[^>]*>/g)) {
    const tag = match[0];
    const name = attributeIn(tag, "name");
    if (!name) {
      continue;
    }
    if ((attributeIn(tag, "type") ?? "text") === "checkbox") {
      if (/\bchecked\b/.test(tag)) {
        values.set(name, "on");
      }
      continue;
    }
    values.set(name, attributeIn(tag, "value") ?? "");
  }
  for (const match of source.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)) {
    const name = attributeIn(match[0], "name");
    const selected =
      match[0].match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/) ??
      match[0].match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/);
    if (name && selected) {
      values.set(name, selected[1]);
    }
  }
  return { get: (name) => values.get(name) ?? null, has: (name) => values.has(name), size: values.size };
}

/** attributeIn returns one attribute's value from a fragment, or null. */
export function attributeIn(markup, name) {
  const match = String(markup).match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function blockMarkup(html, marker, tag) {
  const source = String(html);
  const at = source.indexOf(marker);
  if (at < 0) {
    return "";
  }
  const opening = source.lastIndexOf(`<${tag}`, at);
  const closing = source.indexOf(`</${tag}>`, at);
  if (opening < 0 || closing < 0) {
    return "";
  }
  return source.slice(opening, closing + tag.length + 3);
}
