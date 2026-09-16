const crypto = require("crypto");
const BackupOperationLock = require("../models/backupOperationLock.model");

const LOCK_ID = "backup-restore";
const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000;

async function acquireOperationLock(operation, metadata = {}, leaseMs = DEFAULT_LEASE_MS) {
  const owner = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);

  try {
    const lock = await BackupOperationLock.findOneAndUpdate(
      {
        _id: LOCK_ID,
        $or: [{ expiresAt: { $lte: now } }, { owner }],
      },
      { $set: { owner, operation, expiresAt, metadata } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return lock ? { owner, operation, expiresAt } : null;
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

async function renewOperationLock(lock, leaseMs = null) {
  if (!lock?.owner) return false;
  const effectiveLeaseMs = leaseMs || (lock.operation === "restore" ? 2 * 60 * 60 * 1000 : DEFAULT_LEASE_MS);
  const expiresAt = new Date(Date.now() + effectiveLeaseMs);
  const result = await BackupOperationLock.updateOne(
    { _id: LOCK_ID, owner: lock.owner },
    { $set: { expiresAt } },
  );
  if (result.modifiedCount === 1) lock.expiresAt = expiresAt;
  return result.matchedCount === 1;
}

async function releaseOperationLock(lock) {
  if (!lock?.owner) return;
  await BackupOperationLock.deleteOne({ _id: LOCK_ID, owner: lock.owner });
}

async function getActiveOperation() {
  return BackupOperationLock.findOne({
    _id: LOCK_ID,
    expiresAt: { $gt: new Date() },
  }).lean();
}

module.exports = {
  acquireOperationLock,
  renewOperationLock,
  releaseOperationLock,
  getActiveOperation,
};
