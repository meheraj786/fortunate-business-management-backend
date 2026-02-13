const Decimal = require("decimal.js");

/**
 * Utility for safe financial mathematics using decimal.js
 * Minimizes floating point errors (e.g., 0.1 + 0.2 != 0.3)
 */

// Add two numbers
const add = (a, b) => {
    return new Decimal(a || 0).plus(b || 0).toNumber();
};

// Subtract b from a
const sub = (a, b) => {
    return new Decimal(a || 0).minus(b || 0).toNumber();
};

// Multiply two numbers
const mul = (a, b) => {
    return new Decimal(a || 0).times(b || 0).toNumber();
};

// Divide a by b
const div = (a, b) => {
    if (!b || b === 0) return 0; // Handle division by zero safely
    return new Decimal(a || 0).dividedBy(b).toNumber();
};

// Round to specific decimal places (default 2)
const round = (value, places = 2) => {
    if (value === undefined || value === null) return 0;
    return new Decimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toNumber();
};

// Sum an array of numbers
const sum = (numbers) => {
    if (!Array.isArray(numbers)) return 0;
    return numbers.reduce((acc, val) => add(acc, val), 0);
};

module.exports = {
    add,
    sub,
    mul,
    div,
    round,
    sum,
};
