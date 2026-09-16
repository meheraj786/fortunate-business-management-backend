const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const BACKUP_FILENAME_REGEX =
  /^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{3})?\.zip(?:\.enc)?$/;

const OPERATIONAL_COLLECTIONS = new Set([
  "backuphistories",
  "backupoperationlocks",
  "refreshtokens",
]);

function isSafeBackupFilename(filename) {
  return typeof filename === "string" && BACKUP_FILENAME_REGEX.test(filename);
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Backup archive is empty");
  }

  for (const rawName of entries) {
    const name = String(rawName || "").replace(/\\/g, "/");
    const normalized = path.posix.normalize(name);
    if (
      !name ||
      name.includes("\0") ||
      path.posix.isAbsolute(name) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      /^[A-Za-z]:\//.test(name)
    ) {
      throw new Error(`Unsafe archive entry: ${rawName}`);
    }
  }
}

function buildRestoreArgs(uri, dumpDir, sourceDatabase, targetDatabase, options = {}) {
  if (!uri || !dumpDir || !sourceDatabase || !targetDatabase) {
    throw new Error("Restore command requires URI, dump directory, source database, and target database");
  }

  const args = [
    "--uri",
    uri,
    "--drop",
    "--stopOnError",
    "--nsFrom",
    `${sourceDatabase}.*`,
    "--nsTo",
    `${targetDatabase}.*`,
    "--dir",
    dumpDir,
  ];
  if (options.dryRun) args.push("--dryRun");
  return args;
}

async function countBsonDocuments(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let offset = 0;
    let count = 0;
    const lengthBuffer = Buffer.allocUnsafe(4);

    while (offset < size) {
      const { bytesRead } = await handle.read(lengthBuffer, 0, 4, offset);
      if (bytesRead !== 4) {
        throw new Error(`Truncated BSON document header at byte ${offset}`);
      }

      const documentLength = lengthBuffer.readInt32LE(0);
      if (documentLength < 5 || offset + documentLength > size) {
        throw new Error(`Invalid BSON document length ${documentLength} at byte ${offset}`);
      }

      const terminator = Buffer.allocUnsafe(1);
      const endRead = await handle.read(
        terminator,
        0,
        1,
        offset + documentLength - 1,
      );
      if (endRead.bytesRead !== 1 || terminator[0] !== 0) {
        throw new Error(`Invalid BSON document terminator at byte ${offset}`);
      }

      offset += documentLength;
      count += 1;
    }

    return count;
  } finally {
    await handle.close();
  }
}

async function gatherManifestFromDump(dumpRoot, metadata = {}) {
  const databaseEntries = await fsp.readdir(dumpRoot, { withFileTypes: true });
  const databaseDirectories = databaseEntries.filter((entry) => entry.isDirectory());

  if (databaseDirectories.length !== 1) {
    throw new Error(
      `Backup must contain exactly one database; found ${databaseDirectories.length}`,
    );
  }

  const dbName = databaseDirectories[0].name;
  const databasePath = path.join(dumpRoot, dbName);
  const dumpEntries = await fsp.readdir(databasePath, { withFileTypes: true });
  const bsonEntries = dumpEntries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".bson"),
  );

  if (bsonEntries.length === 0) {
    throw new Error("Backup database dump contains no BSON collections");
  }

  const collections = [];
  for (const entry of bsonEntries) {
    const encodedName = entry.name.slice(0, -5);
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      // Keep the dump filename if it is not URI encoded.
    }
    if (OPERATIONAL_COLLECTIONS.has(name)) continue;

    collections.push({
      name,
      documentCount: await countBsonDocuments(path.join(databasePath, entry.name)),
    });
  }

  collections.sort((a, b) => a.name.localeCompare(b.name));
  return {
    formatVersion: 2,
    appVersion: metadata.appVersion || null,
    dbName,
    collections,
    totalDocuments: collections.reduce((sum, item) => sum + item.documentCount, 0),
  };
}

async function compareRestoredCollections(db, manifest) {
  if (!manifest?.collections?.length) {
    return {
      verified: false,
      reason: "This legacy backup has no collection manifest",
      expectedTotal: null,
      actualTotal: null,
      collections: [],
    };
  }

  const results = [];
  for (const expected of manifest.collections) {
    if (OPERATIONAL_COLLECTIONS.has(expected.name)) continue;
    const actualCount = await db.collection(expected.name).countDocuments({});
    results.push({
      name: expected.name,
      expected: expected.documentCount,
      actual: actualCount,
      matches: expected.documentCount === actualCount,
    });
  }

  const expectedTotal = results.reduce((sum, item) => sum + item.expected, 0);
  const actualTotal = results.reduce((sum, item) => sum + item.actual, 0);
  return {
    verified: results.every((item) => item.matches),
    reason: null,
    expectedTotal,
    actualTotal,
    collections: results,
  };
}

async function gatherDirectoryManifest(rootPath) {
  const hash = crypto.createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(currentPath, relativePath = "") {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const childRelative = path.posix.join(
        relativePath,
        entry.name.replace(/\\/g, "/"),
      );

      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported in uploaded files: ${childRelative}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;

      const stats = await fsp.stat(absolutePath);
      hash.update(childRelative);
      hash.update("\0");
      hash.update(String(stats.size));
      hash.update("\0");
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(absolutePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      fileCount += 1;
      totalBytes += stats.size;
    }
  }

  await visit(rootPath);
  return { fileCount, totalBytes, checksum: hash.digest("hex") };
}

module.exports = {
  BACKUP_FILENAME_REGEX,
  OPERATIONAL_COLLECTIONS,
  isSafeBackupFilename,
  validateArchiveEntries,
  buildRestoreArgs,
  countBsonDocuments,
  gatherManifestFromDump,
  compareRestoredCollections,
  gatherDirectoryManifest,
};
