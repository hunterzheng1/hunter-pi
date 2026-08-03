import { mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function createTemporaryTestDirectory(
  parent: string,
  prefix: string,
): Promise<string> {
  const resolvedParent = resolve(parent);
  const canonicalParent = await realpath(resolvedParent);
  const created = await mkdtemp(join(canonicalParent, prefix));
  const canonical = await realpath(created);
  const relativeChild = relative(canonicalParent, canonical);
  if (
    relativeChild.length === 0 ||
    relativeChild === ".." ||
    relativeChild.startsWith(`..${sep}`) ||
    isAbsolute(relativeChild)
  ) {
    throw new Error("temporary fixture escaped its declared parent");
  }
  return canonical;
}
