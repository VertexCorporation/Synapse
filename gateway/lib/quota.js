/*
 * Gateway - Quota helpers
 * Calendar-month budgets, computed in a configurable time zone.
 */

const DEFAULT_TIMEZONE = 'Europe/Istanbul';

/**
 * Formats a Date as "YYYY-MM" in the given zone.
 * @param {Date} date
 * @param {string} timeZone IANA zone name.
 * @returns {string}
 */
export function monthKey(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    return `${year}-${month}`;
}

/**
 * Returns the offset (in minutes) of a zone at a given instant.
 */
function zoneOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const get = t => Number(parts.find(p => p.type === t).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * The instant the budget resets: first day of the next month, 00:00 in the zone.
 * @param {string} key "YYYY-MM" month key.
 * @param {string} timeZone
 * @returns {Date}
 */
export function monthResetAt(key, timeZone = DEFAULT_TIMEZONE) {
    const [year, month] = key.split('-').map(Number);
    // Local midnight of the next month, first assumed to be UTC, then corrected by the zone offset.
    const naive = new Date(Date.UTC(year, month, 1, 0, 0, 0));
    const offset = zoneOffsetMinutes(naive, timeZone);
    return new Date(naive.getTime() - offset * 60000);
}

/**
 * Parses a positive USD amount from a var/string; falls back when unusable.
 */
export function parseUsd(value, fallback) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Rounds to 6 decimals to keep ledgers free of floating-point dust.
 */
export function roundUsd(n) {
    return Math.round(n * 1e6) / 1e6;
}
