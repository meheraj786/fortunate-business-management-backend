const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const auditService = require("../services/audit.service");
const BackupHistory = require("../models/backupHistory.model");
const { createBackup } = require("./backup.controller");
const {
  BACKUP_FILENAME_REGEX,
  OPERATIONAL_COLLECTIONS,
  buildRestoreArgs,
  compareRestoredCollections,
  gatherDirectoryManifest,
} = require("../utils/backup.util");
const {
  computeFileChecksum,
  openBackupArchive,
  extractBackupArchive,
} = require("../services/backupArchive.service");
const {
  acquireOperationLock,
  renewOperationLock,
  releaseOperationLock,
} = require("../services/backupOperation.service");
const {
  writeRestoreMarker,
  clearRestoreMarker,
} = require("../middleware/restoreMaintenance.middleware");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const DB_URI = process.env.MONGODB_URI;
const RESTORE_LEASE_MS = 2 * 60 * 60 * 1000;
const BACKUP_COMMAND_TIMEOUT_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.BACKUP_COMMAND_TIMEOUT_MS) || 60 * 60 * 1000,
);

async function pathExists(filePath) {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

async function createTempDirectory(prefix) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  return fsp.mkdtemp(path.join(BACKUP_DIR, prefix));
}

async function removeDirectory(directory) {
  if (!directory) return;
  try { await fsp.rm(directory, { recursive: true, force: true }); }
  catch (error) { logger.error(`[Restore] Failed to clean ${directory}:`, error); }
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.collections) || !manifest.dbName) {
    throw new ApiError(400, "This backup has no usable manifest and cannot be restored safely. Create a new verified backup first.");
  }
  for (const collection of manifest.collections) {
    if (!collection?.name || !Number.isInteger(collection.documentCount) || collection.documentCount < 0) {
      throw new ApiError(400, "Backup manifest contains invalid collection counts.");
    }
  }
}

async function preflightBackup(filePath, tempDirectory, history = null) {
  const checksum = await computeFileChecksum(filePath);
  if (history?.checksum && history.checksum !== checksum) {
    await BackupHistory.updateOne(
      { _id: history._id },
      { $set: { status: "corrupted", errorMessage: "SHA-256 checksum mismatch" } },
    );
    throw new ApiError(400, "Backup integrity check failed: SHA-256 checksum mismatch.");
  }
  let archive;
  try {
    archive = await openBackupArchive(filePath, {
      password: process.env.BACKUP_ENCRYPTION_PASSWORD,
      tempDirectory,
    });
  } catch (error) {
    throw new ApiError(400, `Backup archive authentication/structure check failed: ${error.message}`);
  }
  validateManifest(archive.manifest);
  if (typeof fsp.statfs === "function") {
    const disk = await fsp.statfs(BACKUP_DIR);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const requiredBytes = archive.extractedBytes + 512 * 1024 * 1024;
    if (freeBytes < requiredBytes) {
      throw new ApiError(
        507,
        `Insufficient disk space for safe extraction. Required approximately ${Math.ceil(requiredBytes / 1024 / 1024)} MB.`,
      );
    }
  }
  return { ...archive, checksum };
}

async function inspectBackup(req, res, next) {
  let tempDirectory;
  try {
    const { filename } = req.params;
    if (!BACKUP_FILENAME_REGEX.test(filename)) throw new ApiError(400, "Invalid backup filename");
    const filePath = path.join(BACKUP_DIR, filename);
    if (!(await pathExists(filePath))) throw new ApiError(404, "Backup file not found");

    tempDirectory = await createTempDirectory("_inspect-");
    const history = await BackupHistory.findOne({ filename }).lean();
    const preflight = await preflightBackup(filePath, tempDirectory, history);
    const stats = await fsp.stat(filePath);
    return res.status(200).json(new ApiResponse(200, {
      filename,
      sizeBytes: stats.size,
      size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
      createdAt: stats.birthtime,
      encrypted: filename.endsWith(".zip.enc"),
      manifest: preflight.manifest,
      hasManifest: true,
      checksum: preflight.checksum,
      status: history?.status || "verified",
      validation: {
        checksumVerified: !history?.checksum || history.checksum === preflight.checksum,
        archiveReadable: true,
        sourceDatabase: preflight.sourceDatabase,
        includesUploads: preflight.hasUploads,
        bsonFileCount: preflight.bsonFileCount,
      },
    }, "Backup passed restore preflight checks"));
  } catch (error) {
    return next(error instanceof ApiError ? error : new ApiError(400, `Backup preflight failed: ${error.message}`));
  } finally {
    await removeDirectory(tempDirectory);
  }
}

async function runCommand(command, args, timeoutMs = BACKUP_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stderr = "";
    let stdout = "";
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });
    proc.on("error", (error) => finish(() => reject(new Error(`${command} process error: ${error.message}`))));
    proc.on("close", (code) => finish(() => {
      if (code !== 0) {
        logger.error(`${command} failed with code ${code}: ${stderr}`);
        reject(new Error(`${command} failed with exit code ${code}`));
      } else resolve([stdout, stderr].filter(Boolean).join("\n"));
    }));
    timer = setTimeout(() => {
      proc.kill("SIGTERM");
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`)));
    }, timeoutMs);
  });
}

async function removeUnexpectedCollections(db, manifest) {
  const expected = new Set(manifest.collections.map((item) => item.name));
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const removed = [];
  for (const collection of collections) {
    if (collection.name.startsWith("system.") || OPERATIONAL_COLLECTIONS.has(collection.name) || expected.has(collection.name)) continue;
    await db.collection(collection.name).drop();
    removed.push(collection.name);
  }
  return removed;
}

async function restoreExtractedDatabase(dbDumpPath, sourceDatabase, targetDatabase) {
  return runCommand("mongorestore", buildRestoreArgs(DB_URI, dbDumpPath, sourceDatabase, targetDatabase));
}

async function dryRunExtractedDatabase(dbDumpPath, sourceDatabase, targetDatabase) {
  return runCommand(
    "mongorestore",
    buildRestoreArgs(DB_URI, dbDumpPath, sourceDatabase, targetDatabase, { dryRun: true }),
  );
}

async function copyDirectory(source, destination) {
  await fsp.mkdir(destination, { recursive: true });
  await fsp.cp(source, destination, { recursive: true, force: true });
}

function compactValidation(validation) {
  return {
    verified: validation.verified,
    expectedTotal: validation.expectedTotal,
    actualTotal: validation.actualTotal,
    mismatches: validation.collections.filter((item) => !item.matches).slice(0, 50)
      .map(({ name, expected, actual }) => ({ name, expected, actual })),
  };
}

async function upsertRestoreHistory(id, base, changes) {
  return BackupHistory.findOneAndUpdate(
    { _id: id },
    { $set: { ...base, ...changes } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function preserveHistoryRecord(record) {
  if (!record?._id) return;
  const plain = typeof record.toObject === "function" ? record.toObject() : { ...record };
  const id = plain._id;
  delete plain._id;
  delete plain.__v;
  await BackupHistory.findOneAndUpdate(
    { _id: id },
    { $set: plain },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

async function restoreFromBackup(req, res, next) {
  const startTime = Date.now();
  const { filename } = req.params;
  const restoreUploads = req.body?.restoreUploads === true;
  let operationLock;
  let markerWritten = false;
  let workDirectory;
  let rollbackDirectory;
  let uploadsBackupDirectory;
  let historyRecord;
  let historyBase;
  let safetyBackup;
  let databaseMutationStarted = false;
  let uploadsMutationStarted = false;
  let phase = "validating";

  try {
    if (!BACKUP_FILENAME_REGEX.test(filename)) throw new ApiError(400, "Invalid backup filename");
    const filePath = path.join(BACKUP_DIR, filename);
    if (!(await pathExists(filePath))) throw new ApiError(404, "Backup file not found");

    operationLock = await acquireOperationLock("restore", {
      filename, initiatedBy: req.user._id.toString(),
    }, RESTORE_LEASE_MS);
    if (!operationLock) throw new ApiError(409, "A backup or restore operation is already running.");

    const sourceHistory = await BackupHistory.findOne({ filename }).lean();
    workDirectory = await createTempDirectory("_restore-");
    const preflight = await preflightBackup(filePath, workDirectory, sourceHistory);
    if (restoreUploads && !preflight.hasUploads) throw new ApiError(400, "This backup does not contain uploaded files.");

    const targetDatabase = mongoose.connection.db.databaseName;
    historyRecord = await BackupHistory.create({
      filename: `restore_from_${filename}_${Date.now()}`,
      type: "restore", status: "running", phase,
      initiatedBy: req.user._id,
      encrypted: filename.endsWith(".zip.enc"),
      restoredFrom: filename, retentionTag: "manual",
      sourceDatabase: preflight.sourceDatabase, targetDatabase,
      manifest: preflight.manifest,
    });
    historyBase = {
      filename: historyRecord.filename, type: "restore",
      initiatedBy: historyRecord.initiatedBy, encrypted: historyRecord.encrypted,
      restoredFrom: filename, retentionTag: "manual",
      sourceDatabase: preflight.sourceDatabase, targetDatabase,
      manifest: preflight.manifest,
    };

    phase = "extracting";
    await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
    await extractBackupArchive(preflight, workDirectory);
    const dbDumpPath = path.join(workDirectory, "db_dump");
    if (preflight.manifest.uploads && restoreUploads) {
      const sourceUploads = await gatherDirectoryManifest(path.join(workDirectory, "uploads"));
      if (sourceUploads.checksum !== preflight.manifest.uploads.checksum) throw new ApiError(400, "Uploaded-file integrity check failed before restore.");
    }

    phase = "restore_dry_run";
    await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
    await dryRunExtractedDatabase(dbDumpPath, preflight.sourceDatabase, targetDatabase);

    writeRestoreMarker({ filename, operationId: historyRecord._id.toString() });
    markerWritten = true;
    logger.warn(`[Restore] Maintenance mode enabled for restore from ${filename}`);

    phase = "creating_safety_backup";
    await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
    safetyBackup = await createBackup(null, null, null, {
      operationLock, backupType: "manual", isSafetyBackup: true,
      initiatedBy: req.user._id,
      notes: `Automatic safety backup before restoring ${filename}`,
    });
    await renewOperationLock(operationLock, RESTORE_LEASE_MS);
    historyBase.safetyBackupFilename = safetyBackup.filename;

    if (restoreUploads && (await pathExists(UPLOADS_DIR))) {
      uploadsBackupDirectory = await createTempDirectory("_uploads-before-restore-");
      await copyDirectory(UPLOADS_DIR, uploadsBackupDirectory);
    }

    phase = "restoring_database";
    await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
    databaseMutationStarted = true;
    await restoreExtractedDatabase(dbDumpPath, preflight.sourceDatabase, targetDatabase);
    await renewOperationLock(operationLock, RESTORE_LEASE_MS);
    await preserveHistoryRecord(sourceHistory);
    await preserveHistoryRecord(safetyBackup.historyRecord);
    const removedCollections = await removeUnexpectedCollections(mongoose.connection.db, preflight.manifest);

    phase = "verifying_database";
    await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
    const validation = await compareRestoredCollections(mongoose.connection.db, preflight.manifest);
    if (!validation.verified) {
      const names = validation.collections.filter((item) => !item.matches).map((item) => item.name).slice(0, 10).join(", ");
      throw new Error(`Post-restore document reconciliation failed: ${names}`);
    }

    let uploadsRestored = false;
    if (restoreUploads) {
      phase = "restoring_uploads";
      await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
      uploadsMutationStarted = true;
      await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
      await copyDirectory(path.join(workDirectory, "uploads"), UPLOADS_DIR);
      if (preflight.manifest.uploads) {
        const restoredUploads = await gatherDirectoryManifest(UPLOADS_DIR);
        if (restoredUploads.checksum !== preflight.manifest.uploads.checksum) throw new Error("Post-restore uploaded-file reconciliation failed");
      }
      uploadsRestored = true;
    }

    // A database snapshot can contain historical refresh tokens. Revoke every
    // restored session so old credentials cannot silently become active again.
    phase = "revoking_restored_sessions";
    await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
    const sessionRevokedAt = new Date();
    await mongoose.connection.db.collection("refreshtokens").deleteMany({});
    await mongoose.connection.db.collection("users").updateMany(
      {},
      { $set: { lastLogoutAt: sessionRevokedAt } },
    );

    const durationMs = Date.now() - startTime;
    const warnings = ["All restored user sessions were revoked; users must sign in again."];
    if ((preflight.manifest.formatVersion || 1) < 2) warnings.push("Restored a legacy manifest; create a new format-v2 backup now.");
    if (removedCollections.length) warnings.push(`Removed ${removedCollections.length} target-only collection(s).`);
    await upsertRestoreHistory(historyRecord._id, historyBase, {
      status: "restored", phase: "completed", durationMs,
      completedAt: new Date(), verifiedAt: new Date(), includesFiles: uploadsRestored,
      validation: compactValidation(validation), warnings,
      notes: `Restored from ${filename}. Safety backup: ${safetyBackup.filename}`,
    });

    auditService.log({
      action: "RESTORE", module: "System", userId: req.user._id,
      description: `Verified restore from ${filename} (${validation.actualTotal} documents). Safety backup: ${safetyBackup.filename}`,
      req,
    });
    return res.status(200).json(new ApiResponse(200, {
      operationId: historyRecord._id, restoredFrom: filename,
      safetyBackup: safetyBackup.filename, durationMs,
      sourceDatabase: preflight.sourceDatabase, targetDatabase,
      validation: compactValidation(validation), uploadsRestored,
      removedCollections, warnings, sessionsRevoked: true,
    }, "Backup restored and reconciled successfully"));
  } catch (error) {
    logger.error(`[Restore] Failed during phase ${phase}:`, error);
    const rollback = { attempted: false, succeeded: false, errorMessage: null };
    if (databaseMutationStarted && safetyBackup?.filename) {
      rollback.attempted = true;
      phase = "rolling_back";
      try {
        if (historyRecord && historyBase) await upsertRestoreHistory(historyRecord._id, historyBase, { phase });
        rollbackDirectory = await createTempDirectory("_rollback-");
        const safetyPath = path.join(BACKUP_DIR, safetyBackup.filename);
        const safetyPreflight = await preflightBackup(safetyPath, rollbackDirectory, safetyBackup.historyRecord);
        await extractBackupArchive(safetyPreflight, rollbackDirectory);
        await restoreExtractedDatabase(path.join(rollbackDirectory, "db_dump"), safetyPreflight.sourceDatabase, mongoose.connection.db.databaseName);
        await removeUnexpectedCollections(mongoose.connection.db, safetyPreflight.manifest);
        const check = await compareRestoredCollections(mongoose.connection.db, safetyPreflight.manifest);
        if (!check.verified) throw new Error("Safety-backup document reconciliation failed");
        await mongoose.connection.db.collection("refreshtokens").deleteMany({});
        await mongoose.connection.db.collection("users").updateMany(
          {},
          { $set: { lastLogoutAt: new Date() } },
        );
        rollback.succeeded = true;
      } catch (rollbackError) {
        rollback.errorMessage = rollbackError.message;
        logger.error("[Restore] CRITICAL: automatic database rollback failed:", rollbackError);
      }
    }

    if (uploadsMutationStarted) {
      try {
        await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
        if (uploadsBackupDirectory) await copyDirectory(uploadsBackupDirectory, UPLOADS_DIR);
      } catch (uploadsError) {
        rollback.errorMessage = [rollback.errorMessage, uploadsError.message].filter(Boolean).join("; ");
        rollback.succeeded = false;
      }
    }

    if (historyRecord && historyBase) {
      try {
        await upsertRestoreHistory(historyRecord._id, historyBase, {
          status: rollback.attempted ? (rollback.succeeded ? "rolled_back" : "rollback_failed") : "failed",
          phase: rollback.attempted ? "rollback_completed" : phase,
          errorMessage: error.message, durationMs: Date.now() - startTime,
          completedAt: new Date(), rollback,
        });
      } catch (historyError) { logger.error("[Restore] Failed to persist failure history:", historyError); }
    }

    const rollbackMessage = rollback.attempted
      ? rollback.succeeded ? " Current data was automatically recovered from the safety backup." : ` CRITICAL: automatic rollback also failed: ${rollback.errorMessage}`
      : " No database changes were made.";
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    return next(new ApiError(statusCode, `Restore failed during ${phase}.${rollbackMessage}`, [], error.message));
  } finally {
    if (markerWritten) {
      try { clearRestoreMarker(); } catch (error) { logger.error("[Restore] Failed to clear maintenance marker:", error); }
    }
    await removeDirectory(workDirectory);
    await removeDirectory(rollbackDirectory);
    await removeDirectory(uploadsBackupDirectory);
    if (operationLock) {
      try { await releaseOperationLock(operationLock); }
      catch (error) { logger.error("[Restore] Failed to release operation lock:", error); }
    }
  }
}

async function uploadBackup(req, res, next) {
  let destinationPath;
  let tempDirectory;
  try {
    if (!req.file) throw new ApiError(400, "No backup file uploaded");
    const originalName = path.basename(req.file.originalname);
    if (!BACKUP_FILENAME_REGEX.test(originalName)) {
      throw new ApiError(400, "Invalid backup filename. Expected backup_YYYY-MM-DD_HH-MM-SS.zip or .zip.enc.");
    }
    destinationPath = path.join(BACKUP_DIR, originalName);
    if (await pathExists(destinationPath)) throw new ApiError(409, `A backup named "${originalName}" already exists.`);
    await fsp.rename(req.file.path, destinationPath);
    req.file.path = destinationPath;

    tempDirectory = await createTempDirectory("_upload-check-");
    const preflight = await preflightBackup(destinationPath, tempDirectory);
    const stats = await fsp.stat(destinationPath);
    const history = await BackupHistory.create({
      filename: originalName, type: "manual", status: "verified",
      initiatedBy: req.user._id, sizeBytes: stats.size,
      encrypted: originalName.endsWith(".zip.enc"), includesFiles: preflight.hasUploads,
      checksum: preflight.checksum, manifest: preflight.manifest,
      retentionTag: "manual", verifiedAt: new Date(),
      notes: "Uploaded externally and passed restore preflight checks",
    });
    auditService.log({ action: "BACKUP", module: "System", userId: req.user._id, description: `Uploaded and verified backup: ${originalName}`, req });
    return res.status(200).json(new ApiResponse(200, {
      filename: originalName, sizeBytes: stats.size,
      size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
      encrypted: history.encrypted, checksum: preflight.checksum,
      manifest: preflight.manifest,
      validation: { archiveReadable: true, sourceDatabase: preflight.sourceDatabase },
    }, "Backup uploaded and verified successfully"));
  } catch (error) {
    const cleanupPath = destinationPath || req.file?.path;
    if (cleanupPath) { try { await fsp.unlink(cleanupPath); } catch { /* best effort */ } }
    return next(error instanceof ApiError ? error : new ApiError(400, `Backup upload validation failed: ${error.message}`));
  } finally {
    await removeDirectory(tempDirectory);
  }
}

module.exports = { inspectBackup, restoreFromBackup, uploadBackup };
