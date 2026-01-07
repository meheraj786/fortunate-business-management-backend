const { startOfDay: dfnsStartOfDay, endOfDay: dfnsEndOfDay } = require("date-fns");
const dateFnsTz = require("date-fns-tz");

// The business's primary timezone. This should be stored in an environment variable.
const BUSINESS_TIMEZONE = process.env.TZ || "Asia/Dhaka";

/**
 * Takes a Date object and returns a new Date object representing the start of the day
 * in the business's timezone. The returned Date is in UTC, but represents 00:00:00
 * in the business timezone.
 * @param {Date | string | number} date - The input date.
 * @returns {Date} - A UTC Date object representing the start of the day in the business timezone.
 */
function startOfDay(date) {
  const zonedDate = dateFnsTz.toZonedTime(date, BUSINESS_TIMEZONE);
  const start = dfnsStartOfDay(zonedDate);
  return dateFnsTz.fromZonedTime(start, BUSINESS_TIMEZONE);
}

/**
 * Takes a Date object and returns a new Date object representing the end of the day
 * in the business's timezone. The returned Date is in UTC, but represents 23:59:59.999
 * in the business timezone.
 * @param {Date | string | number} date - The input date.
 * @returns {Date} - A UTC Date object representing the end of the day in the business timezone.
 */
function endOfDay(date) {
  const zonedDate = dateFnsTz.toZonedTime(date, BUSINESS_TIMEZONE);
  const end = dfnsEndOfDay(zonedDate);
  return dateFnsTz.fromZonedTime(end, BUSINESS_TIMEZONE);}

/**
 * Returns the current time as a UTC Date object.
 * This is a simple wrapper for new Date() to encourage consistency.
 * @returns {Date}
 */
function now() {
  return new Date();
}

/**
 * Formats a date in the business's timezone.
 * @param {Date | string | number} date - The date to format.
 * @param {string} formatString - The date-fns format string.
 * @returns {string} - The formatted date string.
 */
function formatInTimeZone(date, formatString) {
  return dateFnsTz.format(dateFnsTz.toZonedTime(date, BUSINESS_TIMEZONE), formatString, {
    timeZone: BUSINESS_TIMEZONE,
  });
}

module.exports = {
  startOfDay,
  endOfDay,
  now,
  formatInTimeZone,
  BUSINESS_TIMEZONE,
};