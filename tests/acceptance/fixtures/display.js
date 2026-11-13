// Helpers the display-layer cases read a rendered window with: the markup of
// one item or entry, the value of one attribute, and the text a reader sees.

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

/** restoreMarkup returns the markup of one rendered restore result card. */
export function restoreMarkup(html, id) {
  return blockMarkup(html, `data-restore="${id}"`, "article");
}

/** metricsMarkup returns one side of a restore's four-item comparison. */
export function metricsMarkup(html, side) {
  return blockMarkup(html, `data-metrics="${side}"`, "section");
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
