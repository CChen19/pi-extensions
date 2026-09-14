# Pi Sync settings reference

[Back to README](../README.md)

- [Complete version 3 example](#complete-version-3-example)
- [Required backend shapes](#required-backend-shapes)
- [Status display](#status-display)
- [Secret scanning](#secret-scanning)
- [Included content](#included-content)
- [Unsupported old settings and recovery](#unsupported-old-settings-and-recovery)

## ⚙️ Settings

The canonical private user file is:

```text
~/.pi/agent/pi-sync.json
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable.
Missing settings load as unconfigured without creating an agent directory, file, temporary file, or lock.

An explicit setup creates the file atomically.
On POSIX, pi-sync creates and replaces it with mode `0600`.
Pi-sync processes coordinate settings access through `pi-sync.json.mutation-lock`; lock-unaware editors are outside that serialization boundary and should not save the file while a pi-sync settings operation is running.
Credentials stay in this canonical private file and are never shown in menus, reviews, status, notifications, errors, logs, or completion metadata.

A private `pi-sync.local.json` containing a valid version 3 document is copied byte-for-byte to `pi-sync.json`.
The old file remains as a recovery copy.
If both paths exist, `pi-sync.json` wins and the legacy file remains untouched.

### Complete version 3 example

```json
{
  "version": 3,
  "activeSyncSetup": "home",
  "onSwitch": "ask-before-pull",
  "skipSecretScan": false,
  "showStatus": true,
  "storageConnections": {
    "r2": {
      "type": "s3",
      "endpoint": "https://example.r2.cloudflarestorage.com",
      "region": "auto",
      "credentials": {
        "accessKeyId": "<access-key-id>",
        "secretAccessKey": "<secret-access-key>"
      }
    },
    "github": {
      "type": "git",
      "remote": "git@github.com:owner/private-pi-sync.git"
    },
    "nextcloud": {
      "type": "webdav",
      "url": "https://cloud.example.com/remote.php/dav/files/user",
      "credentials": {
        "username": "user",
        "password": "<app-password>"
      }
    }
  },
  "syncSetups": {
    "home": {
      "storage": {
        "connection": "r2",
        "bucket": "personal-pi",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md", "skills", "prompts", "themes"],
        "automatic": true
      }
    },
    "git-backup": {
      "storage": {
        "connection": "github",
        "branch": "pi-sync/home",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "AGENTS.md"],
        "automatic": false
      }
    },
    "webdav-backup": {
      "storage": {
        "connection": "nextcloud",
        "path": "pi-sync/home"
      },
      "sync": {
        "include": ["settings.json", "sessions"],
        "automatic": false
      }
    }
  }
}
```

Cloudflare R2 is persisted as `"type": "s3"`; R2 is a setup preset, not another schema type.
Temporary S3 credentials may additionally include `credentials.sessionToken`.

### Required backend shapes

- **S3/R2 connection:** `type`, `endpoint`, `region`, and `credentials.accessKeyId` / `credentials.secretAccessKey`.
- **S3/R2 setup storage:** `connection`, `bucket`, and complete relative `path`; `branch` is rejected.
- **Git connection:** `type` and a credential-free SSH or HTTPS `remote`.
- **Git setup storage:** `connection`, `branch`, and complete repository `path`; `bucket` is rejected.
- **WebDAV connection:** `type`, HTTPS `url`, and `credentials.username` / `credentials.password`.
- **WebDAV setup storage:** `connection` and complete relative `path`; `bucket` and `branch` are rejected.

Every backend accepts `.` or `./` for its root; both resolve to `./` and share the same local state and backend identity.
New setups default to `./`, independently of the setup name; Git also suggests branch `main`.
For WebDAV, root means directly under the configured collection URL, not the server root.
For R2/S3, it means the selected bucket root, with no literal `./` object-key prefix.
WebDAV and R2/S3 write `latest.json`, `history.json`, and `snapshots/` there; use separate relative folders or prefixes for independent setups sharing storage.
Existing settings, paths, and local state identities remain unchanged. Editing a setup defaults to its current path.
Manually written documents still require an explicit non-empty `storage.path`; use `./` rather than an empty string for root.
Git branches are exclusively managed by pi-sync; an existing branch containing unrelated files is rejected rather than overwritten.
When adding a setup, locally configured destinations are checked before content selection and review, including equivalent connection aliases.
An occupied destination requires an explicit different path; Git requires a different branch because directories do not isolate publications on one branch.
This check does not contact the server or discover setups configured only on other machines.

Every setup requires `sync.include` and explicit `sync.automatic`. Setup asks for automatic sync with Off first; existing values are not rewritten. When enabled, the current setup receives one background startup check in TUI/RPC, including reload/new/resume/fork. Startup no longer performs automatic transfers or opens dialogs; review changes through `/sync`. Print/JSON skip startup checks. Checks compare local hashes and remote metadata against the last sync baseline, so revision changes and missing baselines require review rather than proving a file conflict.

The setting still permits automatic shutdown pushes of selected content when `sessions` is included, in all modes; this is not limited to uploading session files. Reload skips shutdown push. Settings changes apply to subsequent operations; changing this setting does not schedule another startup check until the next session start. Foreground `/sync` cancels a pending check before opening Settings. The check deadline is 30 seconds plus bounded cleanup, with manual retry through `/sync status`; there is no polling. See [Background startup checks](../README.md#background-startup-checks) for recovery and Git cache exceptions.

Recommended includes the nine non-session Pi roots listed below; Minimal includes `settings.json` and `AGENTS.md`. The save review lists every selected path and the full backend destination. R2/S3 requires an explicitly entered existing bucket and never creates one. Saving setup or connection settings does not contact remote storage.

Invalid fields retry without discarding earlier answers. Retryable local I/O failures retain the exact draft for another Save. Stale reviews and invalid settings files require reopening or repairing current settings rather than overwriting them. A separately saved connection remains if the surrounding Add setup flow is cancelled.

**Edit storage location…** changes only bucket, branch, or path. Content and automatic sync belong to the current setup's **Settings** screen; editing another setup's coordinates does not make it current.
`activeSyncSetup` must reference an own-property setup when any setups exist and must be absent when the setup catalog is empty.
A referenced connection cannot be removed.
The current setup must be switched before removal when other setups exist. Removing the last setup is allowed; local removal never deletes remote history.
Two setups cannot resolve to the same normalized backend location.

The global **After switching setup (all setups)** setting persists as `onSwitch` and applies whenever any setup is made current. It accepts:

- `ask-before-pull` — switch, then ask in TUI whether to start a reviewed pull;
- `pull-after-switch` — require observable UI and start the normal reviewed pull;
- `switch-only` — switch without reading or applying remote content.

### Status display

The global `showStatus` setting accepts a boolean and defaults to `true` when omitted from an existing version 3 document.
Set it through **/sync → Settings → Show status (all setups)**; changes are saved and applied immediately for every setup.
When `false`, pi-sync clears and suppresses status text for background checks, manual and automatic transfers, and review attention.
TUI review widgets and TUI/RPC notifications remain available, and lifecycle cleanup still clears any stale status owned by pi-sync.

### Secret scanning

The global `skipSecretScan` setting accepts a boolean and defaults to `false`, including when omitted from an existing version 3 document.
Set it through **/sync → Settings → Skip secret scan (all setups)**; changes are saved immediately and apply to subsequent pushes for every sync setup, including automatic pushes.
When `true`, pushes skip the local secret scan; other safety checks and confirmations remain unchanged.
Enable it only after reviewing the destination and selected content because files containing secrets can be uploaded.
`/sync doctor` still scans and reports possible secrets regardless of this setting.

### Check setup

**More… → Check setup** and `/sync doctor` retain the same route. S3/R2 reads the selected setup's latest pointer with a ten-second deadline and bounded error details; it never writes, deletes, lists buckets, or changes settings. HTTP success does not validate snapshot contents or write access. `NoSuchKey` indicates no snapshot at the path; `NoSuchBucket` indicates a missing bucket; other 404 responses cannot distinguish the two. Authentication and transport failures give credentials/permissions or address/network guidance. Git reads remote snapshots and checks its local cache; write access is not tested. WebDAV retains its isolated conditional-write/cleanup probe and repair of a missing active-snapshot history entry.

### Included content

`sync.include` is ordered and duplicate-free.
Supported Pi roots are:

```text
settings.json, keybindings.json, models.json, AGENTS.md, APPEND_SYSTEM.md,
skills, prompts, themes, extensions, sessions
```

Safe agent-relative custom files or directories may also be included.
Absolute paths, `..`, backslashes, controls, denied secret/settings paths, duplicate case variants, and ambiguous nested paths under reserved roots are rejected.

An empty array is valid.
It means no useful transfer is selected: **Sync now** reports the condition and does not claim that the setup is up to date.
Unselected content remains unmanaged locally and is preserved when republishing existing remote snapshots.

The Included Content editor is a standard bounded multi-select backed by one in-memory draft.
Toggles never write settings.
**Add custom path…** accepts a safe agent-relative file or directory even when it does not exist locally yet, allowing a new environment to select content that exists only in the remote snapshot.
Leaving the editor opens an exact Include/Exclude review with **Save changes**, **Discard changes**, and **Continue editing**; only reviewed Save publishes, while Continue preserves the draft and Discard/cancellation preserves the settings bytes.
RPC remains a read-only summary with the manual `sync.include` path.

Every new snapshot stores the normalized included-content selection separately from the files that happened to exist.
This preserves selected-but-missing paths without syncing `pi-sync.json`, storage credentials, automatic-sync preferences, or setup names.
**Settings → Compare synced content** opens the same review-first flow as a manager operation when local and remote lists differ.
Adoption revalidates the remote head, immutable snapshot, reviewed storage coordinates, and local include list before one atomic settings update.
The saved state changes only `sync.include`, preserves unknown settings fields, and never pulls files or writes sync state.
Its explicit Continue action starts a fresh **Sync now** route, while **Done** leaves the reviewed settings change saved without implying a file operation.
Keeping this device's list opens the reviewed force-push path and explicitly replaces the remote policy while preserving eligible unmanaged remote files.

Startup checks report an explicit remote-policy difference without applying it. Pull, including forced pull, pauses on that difference rather than silently expanding local scope.
Status reports matches and exact local-only/remote-only paths.
Old snapshots remain readable.
Because they have no authoritative selection, pi-sync offers only a clearly labeled read-only partial discovery from safe remote file roots; selected-but-missing and preserved-unmanaged intent cannot be reconstructed.
Use **Add custom path…** for any needed path.

Adding `sessions` requires a privacy acknowledgement in interactive flows.
Session JSONL can contain prompts, tool output, file paths, images, and secrets.
Pull protects the currently open session file; restart Pi or resume a pulled session to use newly synchronized conversations.

### Unsupported old settings and recovery

Version 1, version 2, and non-empty unversioned documents are unsupported after the version 3 schema reset.
Pi Sync does **not** migrate, partially interpret, downgrade, or overwrite them.
Automatic sync pauses and reports an actionable version 3 error without displaying secrets.

Recovery:

1. retain the old file byte-for-byte;
2. move it aside manually;
3. create a new version 3 document or run the setup manager;
4. run `/sync doctor`, inspect the exact storage path, and review the first pull or push;
5. restore the retained file and a compatible older package only if rolling back.

Malformed, invalid, unsupported, symlinked, or concurrently changed documents remain untouched.
Failed UI saves keep the previous file and displayed/effective state.
