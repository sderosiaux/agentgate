import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Big enough for any source file, small enough that a stray archive is not read into memory. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** A bound on the walk, so a demo case cannot turn into a full disk scan. */
const MAX_FILES = 50_000;

/**
 * What the scan did not look inside, in the three ways it can happen.
 *
 * Reported rather than hidden, for the same reason the file cap is: "I found nothing" and "I
 * found nothing in the part I read" are different claims, and a demo about authorization is
 * the wrong place to blur them. A reader who knows a 2 MiB blob went unread can go and look at
 * it; one who is only shown "0 hits" cannot.
 */
export interface ScanExclusions {
  /** Files larger than {@link MAX_FILE_BYTES}. */
  overSizeCap: number;
  /** Links, and therefore whatever they point at. */
  symlinks: number;
  /** Files left unread because the walk hit its own ceiling. */
  overFileCap: number;
  /** Directories this process could not list. */
  unreadableDirectories: number;
  /** Files that could not be opened or read — permissions, a race, a broken device. */
  unreadableFiles: number;
}

export interface ScanResult {
  filesScanned: number;
  /** Paths, relative to the root, whose contents hold the needle. */
  hits: string[];
  excluded: ScanExclusions;
}

/** Whether anything at all was left out, i.e. whether the result needs a caveat. */
export function hasExclusions(excluded: ScanExclusions): boolean {
  return Object.values(excluded).some((count) => count > 0);
}

/** The caveat, in words, listing only the kinds that actually occurred. */
export function describeExclusions(excluded: ScanExclusions): string {
  const parts: string[] = [];

  if (excluded.overSizeCap > 0) {
    parts.push(
      `${String(excluded.overSizeCap)} file${excluded.overSizeCap === 1 ? '' : 's'} over the ${String(MAX_FILE_BYTES / 1024 / 1024)} MiB cap`,
    );
  }
  if (excluded.symlinks > 0) {
    parts.push(`${String(excluded.symlinks)} symlink${excluded.symlinks === 1 ? '' : 's'}`);
  }
  if (excluded.overFileCap > 0) {
    parts.push(`${String(excluded.overFileCap)} beyond the ${String(MAX_FILES)} file ceiling`);
  }
  if (excluded.unreadableFiles > 0) {
    parts.push(
      `${String(excluded.unreadableFiles)} unreadable file${excluded.unreadableFiles === 1 ? '' : 's'}`,
    );
  }
  if (excluded.unreadableDirectories > 0) {
    parts.push(
      `${String(excluded.unreadableDirectories)} unreadable director${excluded.unreadableDirectories === 1 ? 'y' : 'ies'}`,
    );
  }

  return parts.join(', ');
}

/**
 * Looks for a string across everything the agent can read, starting at `root`.
 *
 * Symlinks are not followed: under pnpm every dependency is one, and following them turns a
 * scan of the agent's own image into a scan of whatever else happens to be mounted — which
 * would make the answer depend on where the demo was run rather than on what the agent holds.
 */
export async function scanForString(root: string, needle: string): Promise<ScanResult> {
  const result: ScanResult = {
    filesScanned: 0,
    hits: [],
    excluded: {
      overSizeCap: 0,
      symlinks: 0,
      overFileCap: 0,
      unreadableDirectories: 0,
      unreadableFiles: 0,
    },
  };
  const queue: string[] = [root];

  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) {
      break;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // A directory this process may not read is not a place the token could be hiding *for
      // this process* either — but it is still a gap in the claim, so it is counted.
      result.excluded.unreadableDirectories += 1;
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        result.excluded.symlinks += 1;
        continue;
      }
      if (entry.name === '.git') {
        continue;
      }

      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (result.filesScanned >= MAX_FILES) {
        result.excluded.overFileCap += 1;
        continue;
      }

      try {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) {
          result.excluded.overSizeCap += 1;
          continue;
        }

        const contents = await readFile(full, 'utf8');

        // Counted only once the bytes are in hand. Incrementing before the read made a file
        // this process cannot open — the exact thing a hidden secret would be sitting in —
        // count towards "scanned" and towards no exclusion at all, so the one number the case
        // publishes was the one number it could not support.
        result.filesScanned += 1;

        if (contents.includes(needle)) {
          result.hits.push(path.relative(root, full));
        }
      } catch {
        result.excluded.unreadableFiles += 1;
        continue;
      }
    }
  }

  return result;
}
