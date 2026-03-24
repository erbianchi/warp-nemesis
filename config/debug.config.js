/** @module debug.config
 * Lightweight runtime debug flags driven by URL query params. */

const TRUTHY_QUERY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function normalizeQueryInput(source = '') {
  const raw = typeof source === 'string'
    ? source
    : typeof source === 'object' && source !== null
      ? [
          source.search,
          source.href,
          source.pathname,
          source.hash,
        ].find(value => typeof value === 'string' && value.length > 0) ?? ''
      : '';

  if (!raw) return '';
  if (raw.startsWith('?')) return raw;
  if (raw.startsWith('&')) return `?${raw.slice(1)}`;

  const questionIndex = raw.indexOf('?');
  if (questionIndex !== -1) return raw.slice(questionIndex);

  const pathParamIndex = raw.indexOf('/&');
  if (pathParamIndex !== -1) return `?${raw.slice(pathParamIndex + 2)}`;

  return raw.includes('=') ? `?${raw.replace(/^[/#&]+/, '')}` : '';
}

/**
 * Parse browser query params into local debug options.
 * @param {string|{search?: string, href?: string, pathname?: string, hash?: string}} [search='']
 *   A raw URL search string, full href, or location-like object.
 * @returns {{debugEnd: boolean}}
 */
export function readDebugOptions(search = '') {
  const params = new URLSearchParams(normalizeQueryInput(search));
  const rawDebugEnd = params.get('debugEnd');

  return {
    debugEnd: rawDebugEnd !== null && TRUTHY_QUERY_VALUES.has(String(rawDebugEnd).toLowerCase()),
  };
}
