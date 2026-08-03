import { relative, sep } from "node:path";

/**
 * @param {string} consumerDirectory package.json directory.
 * @param {string} archivePath packed dependency archive.
 * @returns {string} portable npm file dependency specifier.
 */
export const createRelativeFileSpecifier = (consumerDirectory, archivePath) =>
  `file:${relative(consumerDirectory, archivePath).split(sep).join("/")}`;
