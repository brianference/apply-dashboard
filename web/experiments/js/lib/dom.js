/**
 * The three DOM helpers this page needs.
 *
 * text() rather than innerHTML anywhere a value from the database is shown:
 * every company name and job title in this table is third-party text off
 * somebody else's job board.
 */

/**
 * @param {string} tag
 * @param {object} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

/**
 * @param {string} selector
 * @returns {HTMLElement}
 */
export function mount(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`no element matches ${selector}`);
  return node;
}

/**
 * @param {HTMLElement} node
 * @param {Array<Node|string>} children
 * @returns {void}
 */
export function replace(node, children) {
  node.replaceChildren(...children.map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
}
