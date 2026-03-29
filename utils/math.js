/** @module math */

/**
 * Clamp a numeric value into an inclusive range.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalize an arbitrary value into a finite number.
 * @param {unknown} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalize an arbitrary value into a non-negative integer.
 * @param {unknown} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}
