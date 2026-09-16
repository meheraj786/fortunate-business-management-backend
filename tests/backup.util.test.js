const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fsp = require("fs").promises;
const { serialize } = require("bson");
const fs = require("fs");
const archiver = require("archiver");
const {
  isSafeBackupFilename,
  validateArchiveEntries,
  buildRestoreArgs,
  countBsonDocuments,
  gatherManifestFromDump,
  compareRestoredCollections,
} = require("../utils/backup.util");
const { getCronExpression } = require("../services/backupScheduler.service");
const {
  computeFileChecksum,
  openBackupArchive,
  extractBackupArchive,
} = require("../services/backupArchive.service");
const BackupHistory = require("../models/backupHistory.model");

test("backup filenames accept legacy and millisecond formats only", () => {
  assert.equal(isSafeBackupFilename("backup_2026-09-16_02-00-00.zip"), true);
  assert.equal(isSafeBackupFilename("backup_2026-09-16_02-00-00-123.zip.enc"), true);
  assert.equal(isSafeBackupFilename("../backup_2026-09-16_02-00-00.zip"), false);
  assert.equal(isSafeBackupFilename("backup.zip"), false);
});

test("archive validation blocks traversal and absolute paths", () => {
  assert.doesNotThrow(() => validateArchiveEntries(["manifest.json", "db_dump/source/users.bson"]));
  assert.throws(() => validateArchiveEntries(["../outside"]), /Unsafe archive entry/);
  assert.throws(() => validateArchiveEntries(["C:\\outside"]), /Unsafe archive entry/);
  assert.throws(() => validateArchiveEntries(["/etc/passwd"]), /Unsafe archive entry/);
});

test("restore arguments explicitly map source database into target database", () => {
  const args = buildRestoreArgs("mongodb://localhost/target", "/tmp/dump", "source", "target");
  assert.deepEqual(args.slice(3, 9), [
    "--stopOnError",
    "--nsFrom",
    "source.*",
    "--nsTo",
    "target.*",
    "--dir",
  ]);
  assert.equal(args.at(-1), "/tmp/dump");
  assert.equal(buildRestoreArgs("uri", "dump", "a", "b", { dryRun: true }).at(-1), "--dryRun");
});

test("BSON dump counts are exact and power the manifest", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fortunate-backup-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dbDir = path.join(root, "source_db");
  await fsp.mkdir(dbDir);
  const docs = [serialize({ _id: 1, name: "A" }), serialize({ _id: 2, name: "B" })];
  const bsonPath = path.join(dbDir, "customers.bson");
  await fsp.writeFile(bsonPath, Buffer.concat(docs));

  assert.equal(await countBsonDocuments(bsonPath), 2);
  const manifest = await gatherManifestFromDump(root, { appVersion: "1.2.3" });
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.dbName, "source_db");
  assert.equal(manifest.totalDocuments, 2);
  assert.deepEqual(manifest.collections, [{ name: "customers", documentCount: 2 }]);
});

test("scheduler preserves midnight and rejects invalid times", () => {
  assert.equal(getCronExpression("Daily", "00:00", "Saturday"), "0 0 * * *");
  assert.equal(getCronExpression("Weekly", "02:30", "Monday"), "30 2 * * 1");
  assert.throws(() => getCronExpression("Daily", "25:00", "Saturday"), /Invalid/);
});

test("archive preflight and extraction preserve a valid portable backup", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fortunate-archive-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "target");
  const zipPath = path.join(root, "backup_2026-09-16_02-00-00.zip");
  await fsp.mkdir(path.join(sourceDir, "db_dump", "source_db"), { recursive: true });
  await fsp.writeFile(path.join(sourceDir, "db_dump", "source_db", "users.bson"), serialize({ _id: 1 }));
  await fsp.writeFile(path.join(sourceDir, "manifest.json"), JSON.stringify({
    formatVersion: 2,
    dbName: "source_db",
    collections: [{ name: "users", documentCount: 1 }],
    totalDocuments: 1,
  }));

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip");
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });

  const archive = await openBackupArchive(zipPath, { tempDirectory: root });
  assert.equal(archive.sourceDatabase, "source_db");
  assert.equal(archive.bsonFileCount, 1);
  assert.match(await computeFileChecksum(zipPath), /^[a-f0-9]{64}$/);
  await extractBackupArchive(archive, targetDir);
  assert.equal((await fsp.stat(path.join(targetDir, "db_dump", "source_db", "users.bson"))).isFile(), true);
});

test("post-restore reconciliation reports exact mismatches", async () => {
  const counts = new Map([["users", 3], ["sales", 4]]);
  const db = { collection: (name) => ({ countDocuments: async () => counts.get(name) || 0 }) };
  const result = await compareRestoredCollections(db, {
    collections: [
      { name: "users", documentCount: 3 },
      { name: "sales", documentCount: 5 },
    ],
  });
  assert.equal(result.verified, false);
  assert.equal(result.expectedTotal, 8);
  assert.equal(result.actualTotal, 7);
  assert.deepEqual(result.collections.find((item) => item.name === "sales"), {
    name: "sales", expected: 5, actual: 4, matches: false,
  });
});

test("restore outcome history accepts verified rollback metadata", () => {
  const record = new BackupHistory({
    filename: "restore_from_backup.zip",
    type: "restore",
    status: "rolled_back",
    rollback: { attempted: true, succeeded: true },
    validation: { verified: false, expectedTotal: 10, actualTotal: 9 },
  });
  assert.equal(record.validateSync(), undefined);
});
