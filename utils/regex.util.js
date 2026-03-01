/**
 * Escapes special regex characters in a string
 * to prevent ReDoS attacks and unintended pattern matching.
 * @param {string} str - The raw user input string.
 * @returns {string} The escaped string, safe to use in a RegExp.
 */
function escapeRegex(str) {
    if (!str || typeof str !== "string") return "";
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };
