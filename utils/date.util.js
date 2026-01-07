// utils/date.util.js

/**
 * Returns the start of the day for a given date.
 * @param {Date} date - The input date.
 * @returns {Date} - The start of the day (00:00:00.000).
 */
function getStartOfDay(date) {
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
}

/**
 * Returns the end of the day for a given date.
 * @param {Date} date - The input date.
 * @returns {Date} - The end of the day (23:59:59.999).
 */
function getEndOfDay(date) {
  const newDate = new Date(date);
  newDate.setHours(23, 59, 59, 999);
  return newDate;
}

module.exports = {
  getStartOfDay,
  getEndOfDay,
};
