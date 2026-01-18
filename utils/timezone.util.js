const {
  startOfDay: dfnsStartOfDay,
  endOfDay: dfnsEndOfDay,
} = require("date-fns");
const dateFnsTz = require("date-fns-tz");

// Default timezone fallback
const DEFAULT_TIMEZONE = process.env.TZ || "Asia/Dhaka";

/**
 * Takes a Date object and returns a new Date object representing the start of the day
 * in the specified timezone. The returned Date is in UTC, but represents 00:00:00
 * in the business timezone.
 * @param {Date | string | number} date - The input date.
 * @param {string} timezone - Optional timezone (defaults to env TZ or Asia/Dhaka)
 * @returns {Date} - A UTC Date object representing the start of the day in the business timezone.
 */
function startOfDay(date, timezone) {
  const tz = timezone || DEFAULT_TIMEZONE;
  const zonedDate = dateFnsTz.toZonedTime(date, tz);
  const start = dfnsStartOfDay(zonedDate);
  return dateFnsTz.fromZonedTime(start, tz);
}

/**
 * Takes a Date object and returns a new Date object representing the end of the day
 * in the specified timezone. The returned Date is in UTC, but represents 23:59:59.999
 * in the business timezone.
 * @param {Date | string | number} date - The input date.
 * @param {string} timezone - Optional timezone (defaults to env TZ or Asia/Dhaka)
 * @returns {Date} - A UTC Date object representing the end of the day in the business timezone.
 */
function endOfDay(date, timezone) {
  const tz = timezone || DEFAULT_TIMEZONE;
  const zonedDate = dateFnsTz.toZonedTime(date, tz);
  const end = dfnsEndOfDay(zonedDate);
  return dateFnsTz.fromZonedTime(end, tz);
}

/**
 * Returns the current time as a UTC Date object.
 * This is a simple wrapper for new Date() to encourage consistency.
 * @returns {Date}
 */
function now() {
  return new Date();
}

/**
 * Formats a date in the specified timezone.
 * @param {Date | string | number} date - The date to format.
 * @param {string} formatString - The date-fns format string.
 * @param {string} timezone - Optional timezone (defaults to env TZ or Asia/Dhaka)
 * @returns {string} - The formatted date string.
 */
function formatInTimeZone(date, formatString, timezone) {
  const tz = timezone || DEFAULT_TIMEZONE;
  return dateFnsTz.format(dateFnsTz.toZonedTime(date, tz), formatString, {
    timeZone: tz,
  });
}

/**
 * Get the business timezone (for backward compatibility)
 */
const BUSINESS_TIMEZONE = DEFAULT_TIMEZONE;

module.exports = {
  startOfDay,
  endOfDay,
  now,
  formatInTimeZone,
  BUSINESS_TIMEZONE,
  DEFAULT_TIMEZONE,
};
