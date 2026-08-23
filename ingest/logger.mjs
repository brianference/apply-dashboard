/**
 * Small stderr logger for ingest library code. CLI entry points may also print
 * structured JSON to stdout.
 */

/**
 * @param {"info"|"warn"|"error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function log(level, message, extra) {
  const line = extra && Object.keys(extra).length
    ? `${level} ${message} ${JSON.stringify(extra)}`
    : `${level} ${message}`;
  process.stderr.write(`${line}\n`);
}

/** @param {string} message @param {Record<string, unknown>} [extra] */
export function logInfo(message, extra) {
  log("info", message, extra);
}

/** @param {string} message @param {Record<string, unknown>} [extra] */
export function logWarn(message, extra) {
  log("warn", message, extra);
}

/** @param {string} message @param {Record<string, unknown>} [extra] */
export function logError(message, extra) {
  log("error", message, extra);
}
