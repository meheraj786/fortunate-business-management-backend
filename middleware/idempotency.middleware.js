const { ApiError } = require("../utils/ApiError");
const logger = require("../utils/logger");

/**
 * In-memory idempotency key cache with TTL.
 * Prevents double-submit of mutation requests (e.g. rapid double-clicks).
 *
 * Client must send `X-Idempotency-Key` header with a unique UUID per action.
 * If the same key is seen within the TTL window, the request is rejected with 409.
 *
 * NOTE: This is an in-memory cache, suitable for single-instance deployments.
 * For multi-instance/clustered deployments, replace with Redis-backed storage.
 */

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const idempotencyCache = new Map();

// Periodic cleanup of expired keys (every 60 seconds)
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > IDEMPOTENCY_TTL_MS) {
            idempotencyCache.delete(key);
        }
    }
}, 60 * 1000);

/**
 * Middleware factory that checks for duplicate submissions.
 * If no X-Idempotency-Key header is present, the request passes through
 * (backwards compatible — header is optional but recommended).
 */
function idempotencyGuard(req, res, next) {
    const key = req.headers["x-idempotency-key"];

    // If no key provided, allow (backwards compatible)
    if (!key) return next();

    // Namespace the key by user ID to prevent cross-user collisions
    const namespacedKey = `${req.user?._id || "anon"}_${key}`;

    if (idempotencyCache.has(namespacedKey)) {
        return next(
            new ApiError(
                409,
                "Duplicate request detected. This action has already been submitted.",
            ),
        );
    }

    idempotencyCache.set(namespacedKey, Date.now());
    next();
}

module.exports = { idempotencyGuard };
