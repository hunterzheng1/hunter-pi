import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a temporary directory and returns its canonical filesystem path.
 *
 * Windows runners can expose TEMP through an 8.3 alias while npm resolves the
 * same directory to its long path. Canonicalizing once keeps file dependency
 * references and npm's filesystem operations on the same path identity.
 *
 * @param {string} prefix unique directory prefix.
 * @param {string} [baseDirectory] parent directory, injectable for tests.
 * @returns {Promise<string>} canonical path to the created directory.
 */
export const createCanonicalTemporaryDirectory = async (prefix, baseDirectory = tmpdir()) =>
  realpath(await mkdtemp(join(baseDirectory, prefix)));
