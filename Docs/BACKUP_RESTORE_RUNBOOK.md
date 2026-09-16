# Backup and Restore Operations

This module protects both MongoDB business data and, when enabled, the local
`uploads` directory. Restore and backup-file upload are permanently restricted
to `SUPER_ADMIN`; they are not delegable permissions.

## Guarantees in format version 2

- One atomic MongoDB lock prevents overlapping backup and restore operations
  across all PM2 workers.
- Mutating application requests are briefly paused while a backup snapshot is
  captured, preventing cross-collection business changes during `mongodump`.
- A manifest is generated from the BSON dump itself, so collection counts
  describe the actual archive rather than a changing live database.
- SHA-256 protects the complete backup file. ZIP structure and paths are
  checked before restore, and encrypted files must pass AES-GCM authentication.
- The original database namespace is mapped to the current installation's
  database. This supports restoring a backup into a differently named database.
- Restore enables application-wide maintenance mode before the safety snapshot.
- A pre-restore safety backup is mandatory. If database restore, uploads restore,
  or post-restore reconciliation fails, the safety backup is restored
  automatically.
- Target-only business collections are removed so restore actually replaces the
  database rather than leaving stale collections behind.
- Every expected collection is counted after restore. Uploaded files use a
  deterministic tree checksum when the backup includes them.
- All restored login sessions and refresh tokens are revoked after successful
  reconciliation. This prevents old sessions from becoming valid again.
- History records distinguish verified success, failure with successful
  rollback, and critical rollback failure.

## Production prerequisites

1. `mongodump` and `mongorestore` must be installed and from a version compatible
   with the production MongoDB server.
2. The application user must be able to read and write the `backups` directory.
3. Free disk space must cover the source archive, extraction, and a full safety
   backup at the same time. Keep substantially more than two times the expected
   backup size free.
4. If encryption is enabled, securely retain `BACKUP_ENCRYPTION_PASSWORD`
   outside this server. A new installation needs the same value. Losing it makes
   encrypted backups permanently unrecoverable.
5. Local backups do not protect against total server/disk loss. Download or copy
   verified backups to independent, access-controlled off-site storage.
6. The reverse proxy must permit at least `520m` request bodies (500 MB file plus
   multipart overhead) and at least a two-hour
   read/send timeout on API requests. The repository's `nginx.conf` contains the
   matching example; validate the actual production virtual host separately.

The Backup screen displays readiness, MongoDB tool availability, disk space,
encryption configuration, and the latest successful backup.

## Safe restore drill

Perform this regularly and before relying on a backup for a production change:

1. Download a recent backup and verify it in the source system.
2. Prepare an isolated installation with a separate MongoDB database and the
   same application version. For encrypted backups, configure the same backup
   password.
3. Sign in as that installation's Super Admin, upload the backup, and confirm
   that preflight validation passes.
4. Restore it. The result must say `Restored & verified`, with expected and
   actual document totals equal.
   The restore also replaces user accounts; be ready to sign in with a Super
   Admin credential contained in the backup.
5. Verify several high-value records, recent sales, balances, warehouse stock,
   audit history, and representative uploaded documents.
6. Immediately create and download a new backup from the restored system. This
   proves both recovery and the next backup cycle.

Never test a restore against the live production database merely to prove that
it works. Use an isolated restore target.

## Failure response

- `Failed — recovered`: the requested restore failed, but the automatic safety
  rollback reconciled successfully. Investigate the recorded phase and error
  before retrying.
- `Critical recovery failure`: stop application traffic, preserve the `backups`
  directory and logs, and restore the named safety backup manually. Do not run
  cleanup or another restore until the cause is understood.
- A stale data-protection maintenance marker expires after two hours. If a worker was killed,
  inspect PM2 logs and backup history before removing or waiting for the marker.

## Deployment check

After deployment, confirm the readiness card is green, create a manual backup,
verify it, download it, and perform the isolated restore drill. A successful
build alone is not evidence that the server has MongoDB Database Tools installed
or that a real archive can be restored.
