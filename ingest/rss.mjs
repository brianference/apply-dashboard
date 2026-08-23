/**
 * Minimal RSS item parser. No extra XML dependency — Node 22, plain ESM.
 */

/**
 * @param {string} xml
 * @param {string} tag
 * @returns {string}
 */
function textOf(xml, tag) {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdata);
  if (cdataMatch) return cdataMatch[1];
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const plainMatch = xml.match(plain);
  return plainMatch ? plainMatch[1] : "";
}

/**
 * @param {string} value
 * @returns {string}
 */
export function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#038;/g, "&")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Split an RSS document into item records.
 *
 * @param {string} xml
 * @returns {Array<{ title: string, link: string, pubDate: string, region: string, type: string, category: string, creator: string, description: string, guid: string }>}
 */
export function parseRssItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    items.push({
      title: decodeXml(textOf(block, "title")),
      link: decodeXml(textOf(block, "link")),
      pubDate: decodeXml(textOf(block, "pubDate")),
      region: decodeXml(textOf(block, "region")),
      type: decodeXml(textOf(block, "type")),
      category: decodeXml(textOf(block, "category")),
      creator: decodeXml(textOf(block, "dc:creator") || textOf(block, "creator")),
      description: decodeXml(textOf(block, "description")),
      guid: decodeXml(textOf(block, "guid"))
    });
  }
  return items;
}

/**
 * Convert an RSS pubDate to ISO 8601, or return the original string.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function postedFromRss(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}
