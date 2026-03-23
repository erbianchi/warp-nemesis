/** @module debug.config
 * Lightweight runtime debug flags driven by URL query params. */

const TRUTHY_QUERY_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Parse browser query params into local debug options.
 * @param {string} [search=''] - A raw URL search string like '?debugEnd=1'
 * @returns {{debugEnd: boolean}}
 */
export function readDebugOptions(search = '') {
  const params = new URLSearchParams(search);
  const raw = params.get('debugEnd');

  return {
    debugEnd: raw !== null && TRUTHY_QUERY_VALUES.has(String(raw).toLowerCase()),
  };
}
