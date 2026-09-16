const fs = require("fs");
const path = require("path");
const { ApiError } = require("../utils/ApiError");

const MARKER_PATH = path.join(__dirname, "..", "backups", ".restore-in-progress.json");

function writeOperationMarker(details) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  const activeMarker = getActiveMarker();
  if (activeMarker) {
    const error = new Error(`A ${activeMarker.operation || "data-protection"} operation is already marked as running`);
    error.code = "EBUSY";
    throw error;
  }
  fs.writeFileSync(
    MARKER_PATH,
    JSON.stringify({ operation: "restore", ...details, expiresAt: Date.now() + 2 * 60 * 60 * 1000 }),
    { encoding: "utf8", flag: "wx" },
  );
}

function clearRestoreMarker() {
  try {
    fs.unlinkSync(MARKER_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function isRestoreInProgress() {
  return getActiveMarker()?.operation === "restore";
}

function getActiveMarker() {
  try {
    const marker = JSON.parse(fs.readFileSync(MARKER_PATH, "utf8"));
    if (Number(marker.expiresAt) > Date.now()) return marker;
    clearRestoreMarker();
  } catch (error) {
    if (error.code !== "ENOENT") {
      try {
        const stats = fs.statSync(MARKER_PATH);
        if (Date.now() - stats.mtimeMs > 2 * 60 * 60 * 1000) {
          clearRestoreMarker();
          return null;
        }
      } catch {
        return null;
      }
      // A recent malformed/unreadable marker is safer to treat as maintenance.
      return { operation: "restore", unreadable: true };
    }
  }
  return null;
}

function blockRequestsDuringRestore(req, res, next) {
  const marker = getActiveMarker();
  if (!marker) return next();
  if (marker.operation === "backup" && ["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }
  return next(
    new ApiError(
      503,
      marker.operation === "backup"
        ? "A consistent backup snapshot is in progress. Changes are briefly paused."
        : "System restore is in progress. Please wait and try again after it completes.",
    ),
  );
}

module.exports = {
  MARKER_PATH,
  writeOperationMarker,
  writeRestoreMarker: writeOperationMarker,
  clearRestoreMarker,
  isRestoreInProgress,
  getActiveMarker,
  blockRequestsDuringRestore,
};
