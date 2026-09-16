const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { pipeline } = require("stream/promises");
const unzipper = require("unzipper");
const { validateArchiveEntries } = require("../utils/backup.util");

const pbkdf2Async = promisify(crypto.pbkdf2);
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = Number(process.env.BACKUP_MAX_ARCHIVE_ENTRIES) || 100000;
const MAX_EXTRACTED_BYTES = Number(process.env.BACKUP_MAX_EXTRACTED_BYTES) || 10 * 1024 * 1024 * 1024;

async function computeFileChecksum(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function decryptFile(inputPath, outputPath, password) {
  const handle = await fsp.open(inputPath, "r");
  let size;
  let salt;
  let iv;
  let authTag;
  try {
    ({ size } = await handle.stat());
    if (size < 45) throw new Error("Encrypted backup is too small to be valid");

    salt = Buffer.alloc(16);
    iv = Buffer.alloc(12);
    authTag = Buffer.alloc(16);
    await handle.read(salt, 0, salt.length, 0);
    await handle.read(iv, 0, iv.length, 16);
    await handle.read(authTag, 0, authTag.length, size - authTag.length);
  } finally {
    await handle.close();
  }

  const key = await pbkdf2Async(password, salt, 100000, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    await pipeline(
      fs.createReadStream(inputPath, { start: 28, end: size - 17 }),
      decipher,
      fs.createWriteStream(outputPath, { flags: "wx" }),
    );
  } catch (error) {
    try {
      await fsp.unlink(outputPath);
    } catch {
      // Best-effort cleanup.
    }
    throw new Error(`Encrypted backup could not be decrypted or authenticated: ${error.message}`);
  }
}

async function openBackupArchive(filePath, options = {}) {
  const isEncrypted = filePath.endsWith(".enc");
  let zipPath = filePath;
  let decryptedPath = null;

  if (isEncrypted) {
    if (!options.password) {
      throw new Error("BACKUP_ENCRYPTION_PASSWORD is required for this encrypted backup");
    }
    if (!options.tempDirectory) {
      throw new Error("A temporary directory is required to inspect an encrypted backup");
    }
    decryptedPath = path.join(options.tempDirectory, "decrypted-backup.zip");
    await decryptFile(filePath, decryptedPath, options.password);
    zipPath = decryptedPath;
  }

  let directory;
  try {
    directory = await unzipper.Open.file(zipPath);
  } catch (error) {
    throw new Error(`Backup is not a readable ZIP archive: ${error.message}`);
  }

  validateArchiveEntries(directory.files.map((entry) => entry.path));
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Backup contains too many archive entries (${directory.files.length})`);
  }
  const extractedBytes = directory.files.reduce(
    (sum, entry) => sum + (Number(entry.uncompressedSize) || 0),
    0,
  );
  if (extractedBytes > MAX_EXTRACTED_BYTES) {
    throw new Error(`Backup expands beyond the configured safety limit (${extractedBytes} bytes)`);
  }

  const manifestEntry = directory.files.find((entry) => entry.path === "manifest.json");
  let manifest = null;
  if (manifestEntry) {
    if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
      throw new Error("Backup manifest is unexpectedly large");
    }
    try {
      manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
    } catch (error) {
      throw new Error(`Backup manifest is invalid: ${error.message}`);
    }
  }

  const databaseNames = new Set();
  let bsonFileCount = 0;
  let hasUploads = false;
  for (const entry of directory.files) {
    const parts = entry.path.split("/").filter(Boolean);
    if (parts[0] === "db_dump" && parts.length >= 3 && entry.path.endsWith(".bson")) {
      databaseNames.add(parts[1]);
      bsonFileCount += 1;
    }
    if (parts[0] === "uploads" && entry.type !== "Directory") hasUploads = true;
  }

  if (databaseNames.size !== 1 || bsonFileCount === 0) {
    throw new Error(
      `Backup must contain BSON data for exactly one database; found ${databaseNames.size}`,
    );
  }

  const sourceDatabase = [...databaseNames][0];
  if (manifest?.dbName && manifest.dbName !== sourceDatabase) {
    throw new Error(
      `Manifest database (${manifest.dbName}) does not match archive database (${sourceDatabase})`,
    );
  }

  return {
    directory,
    zipPath,
    decryptedPath,
    manifest,
    sourceDatabase,
    hasUploads,
    entryCount: directory.files.length,
    bsonFileCount,
    extractedBytes,
  };
}

async function extractBackupArchive(archive, destination) {
  await fsp.mkdir(destination, { recursive: true });

  for (const entry of archive.directory.files) {
    const normalized = path.posix.normalize(entry.path);
    const destinationPath = path.join(destination, ...normalized.split("/"));
    const resolved = path.resolve(destinationPath);
    const root = path.resolve(destination) + path.sep;
    if (resolved !== path.resolve(destination) && !resolved.startsWith(root)) {
      throw new Error(`Unsafe archive destination: ${entry.path}`);
    }

    if (entry.type === "Directory" || entry.path.endsWith("/")) {
      await fsp.mkdir(destinationPath, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(destinationPath, { flags: "wx" }));
  }
}

module.exports = {
  computeFileChecksum,
  decryptFile,
  openBackupArchive,
  extractBackupArchive,
};
