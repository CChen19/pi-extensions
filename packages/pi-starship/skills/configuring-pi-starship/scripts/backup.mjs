import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatDisplayValue } from "./script-support.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export async function backupExpectedDocument(destinationPath, expected, options = {}) {
  const backupDirectory = join(dirname(destinationPath), "pi-starship");
  const backupPath = join(backupDirectory, `pi-starship-${localTimestamp(options.now ?? new Date())}.toml`);
  const makeDirectory = options.makeDirectory ?? mkdir;
  const openFile = options.openFile ?? open;
  const removeFile = options.removeFile ?? rm;

  await makeDirectory(backupDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  let handle;
  try {
    handle = await openFile(backupPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(expected);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return backupPath;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Backup already exists at ${formatDisplayValue(backupPath)}; the active file was preserved.`);
    }

    const cleanupErrors = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    try {
      await removeFile(backupPath, { force: true });
    } catch (removeError) {
      cleanupErrors.push(removeError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Backup creation failed and its partial file could not be removed; the active file was preserved.",
      );
    }
    throw error;
  }
}

function localTimestamp(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("");
}
