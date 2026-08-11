import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Big enough for any source file, small enough that a stray archive is not read into memory. */
const MAX_FILE_BYTES = 1024 * 1024;

/** A bound on the walk, so a demo case cannot turn into a full disk scan. */
const MAX_FILES = 20_000;

export interface ScanResult {
  filesScanned: number;
  /** Paths, relative to the root, whose contents hold the needle. */
  hits: string[];
}

/**
 * Looks for a string across everything the agent can read, starting at `root`.
 *
 * Symlinks are not followed: under pnpm every dependency is one, and following them turns a
 * scan of the agent's own image into a scan of whatever else happens to be mounted — which
 * would make the answer depend on where the demo was run rather than on what the agent holds.
 */
export async function scanForString(root: string, needle: string): Promise<ScanResult> {
  const result: ScanResult = { filesScanned: 0, hits: [] };
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
      // this process* either, which is the question the case is asking.
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === '.git') {
        continue;
      }

      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile() || result.filesScanned >= MAX_FILES) {
        continue;
      }

      try {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) {
          continue;
        }

        result.filesScanned += 1;
        const contents = await readFile(full, 'utf8');
        if (contents.includes(needle)) {
          result.hits.push(path.relative(root, full));
        }
      } catch {
        continue;
      }
    }
  }

  return result;
}
