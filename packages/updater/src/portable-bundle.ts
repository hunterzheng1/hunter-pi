import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { z } from "zod";

import {
  distributionReleaseIdSchema,
  engineReleaseIdSchema,
  fingerprintSchema,
  type Fingerprint,
} from "@hunter-pi/domain";
import { assertSafeDirectoryPath, canonicalJson, sha256Fingerprint } from "@hunter-pi/evidence";

const portableVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);

const portableRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (value.includes("\\") || value.startsWith("/") || isAbsolute(value)) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }, "portable bundle paths must be relative, normalized, and symlink-free");

const portableBundleFileRecordSchema = z.strictObject({
  path: portableRelativePathSchema,
  fingerprint: fingerprintSchema,
  byteLength: z.number().int().nonnegative(),
});

export const portableBundleManifestSchema = z.strictObject({
  schemaVersion: z.literal("hpi-portable-bundle.v1"),
  product: z.literal("Hunter Pi"),
  releaseId: distributionReleaseIdSchema,
  productVersion: portableVersionSchema,
  engineReleaseId: engineReleaseIdSchema,
  engineReleaseFingerprint: fingerprintSchema,
  platform: z.literal("win32-x64"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceState: z.literal("CLEAN"),
  files: z.array(portableBundleFileRecordSchema).min(1),
});
export type PortableBundleManifest = z.infer<typeof portableBundleManifestSchema>;

export interface PortableBundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PortableBundle {
  readonly manifest: PortableBundleManifest;
  readonly files: readonly PortableBundleFile[];
}

const TAR_BLOCK_SIZE = 512;
const MAX_BUNDLE_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function assertPortablePath(path: string): string {
  return portableRelativePathSchema.parse(path);
}

function byteFingerprint(value: Uint8Array): Fingerprint {
  return fingerprintSchema.parse("sha256:" + createHash("sha256").update(value).digest("hex"));
}

function octal(value: number, width: number): Buffer {
  const text = value.toString(8);
  if (text.length > width - 1) throw new Error("portable bundle tar field is too large");
  return Buffer.from(text.padStart(width - 1, "0") + "\0", "ascii");
}

function writeField(target: Buffer, offset: number, width: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > width) throw new Error("portable bundle path is too long");
  encoded.copy(target, offset);
}

function tarHeader(path: string, byteLength: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  writeField(header, 0, 100, path);
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(byteLength, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  return header;
}

function createTar(files: readonly PortableBundleFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const bytes = Buffer.from(file.bytes);
    chunks.push(tarHeader(file.path, bytes.byteLength), bytes);
    const remainder = bytes.byteLength % TAR_BLOCK_SIZE;
    if (remainder !== 0) chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function readField(header: Buffer, offset: number, width: number): string {
  return header
    .subarray(offset, offset + width)
    .toString("utf8")
    .replace(/\0.*$/u, "")
    .trim();
}

function readOctal(header: Buffer, offset: number, width: number): number {
  const value = readField(header, offset, width);
  if (!/^[0-7]*$/u.test(value)) throw new Error("portable bundle tar number is invalid");
  return value.length === 0 ? 0 : Number.parseInt(value, 8);
}

function isZeroBlock(value: Buffer, offset: number): boolean {
  for (let index = offset; index < offset + TAR_BLOCK_SIZE; index += 1) {
    if (value[index] !== 0) return false;
  }
  return true;
}

function parseTar(value: Buffer): readonly PortableBundleFile[] {
  if (value.byteLength % TAR_BLOCK_SIZE !== 0) {
    throw new Error("portable bundle tar is not block aligned");
  }
  const files: PortableBundleFile[] = [];
  const paths = new Set<string>();
  let offset = 0;
  let totalBytes = 0;
  let terminated = false;
  while (offset + TAR_BLOCK_SIZE <= value.byteLength) {
    if (isZeroBlock(value, offset)) {
      if (
        offset + TAR_BLOCK_SIZE * 2 > value.byteLength ||
        !isZeroBlock(value, offset + TAR_BLOCK_SIZE)
      ) {
        throw new Error("portable bundle tar has an incomplete terminator");
      }
      terminated = true;
      offset += TAR_BLOCK_SIZE * 2;
      break;
    }
    if (files.length >= MAX_BUNDLE_ENTRIES) throw new Error("portable bundle entry limit exceeded");
    const header = value.subarray(offset, offset + TAR_BLOCK_SIZE);
    const expectedChecksum = readOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (expectedChecksum !== actualChecksum) throw new Error("portable bundle tar checksum failed");
    const type = header[156];
    if (type !== 0 && type !== 0x30) throw new Error("portable bundle contains a non-file entry");
    const path = assertPortablePath(readField(header, 0, 100));
    if (paths.has(path)) throw new Error("portable bundle contains a duplicate path");
    paths.add(path);
    const byteLength = readOctal(header, 124, 12);
    totalBytes += byteLength;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("portable bundle byte limit exceeded");
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataOffset + byteLength;
    if (dataEnd > value.byteLength) throw new Error("portable bundle file exceeds archive bounds");
    files.push({ path, bytes: new Uint8Array(value.subarray(dataOffset, dataEnd)) });
    offset = dataOffset + Math.ceil(byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  if (!terminated || offset !== value.byteLength) {
    throw new Error("portable bundle tar has trailing or missing data");
  }
  return files;
}

function normalizedFiles(files: readonly PortableBundleFile[]): readonly PortableBundleFile[] {
  const seen = new Set<string>();
  return [...files]
    .map((file) => ({ path: assertPortablePath(file.path), bytes: new Uint8Array(file.bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      if (file.path === "portable-manifest.json") {
        throw new Error("portable bundle reserves portable-manifest.json");
      }
      if (seen.has(file.path)) throw new Error("portable bundle contains a duplicate path");
      seen.add(file.path);
      return file;
    });
}

export function createPortableBundle(options: {
  readonly releaseId: string;
  readonly productVersion: string;
  readonly engineReleaseId: string;
  readonly engineReleaseFingerprint: string;
  readonly sourceCommit: string;
  readonly files: readonly PortableBundleFile[];
}): Uint8Array {
  const files = normalizedFiles(options.files);
  if (files.length === 0) throw new Error("portable bundle requires at least one file");
  const manifest = portableBundleManifestSchema.parse({
    schemaVersion: "hpi-portable-bundle.v1",
    product: "Hunter Pi",
    releaseId: options.releaseId,
    productVersion: options.productVersion,
    engineReleaseId: options.engineReleaseId,
    engineReleaseFingerprint: options.engineReleaseFingerprint,
    platform: "win32-x64",
    sourceCommit: options.sourceCommit,
    sourceState: "CLEAN",
    files: files.map((file) => ({
      path: file.path,
      fingerprint: byteFingerprint(file.bytes),
      byteLength: file.bytes.byteLength,
    })),
  });
  const manifestFile: PortableBundleFile = {
    path: "portable-manifest.json",
    bytes: Buffer.from(canonicalJson(manifest) + "\n", "utf8"),
  };
  return gzipSync(createTar([...files, manifestFile]), { level: 9 });
}

export function decodePortableBundle(value: Uint8Array): PortableBundle {
  let files: readonly PortableBundleFile[];
  try {
    files = parseTar(gunzipSync(Buffer.from(value)));
  } catch (error) {
    throw new Error("portable bundle archive is invalid", { cause: error });
  }
  const manifestFile = files.find((file) => file.path === "portable-manifest.json");
  if (manifestFile === undefined) throw new Error("portable bundle manifest is missing");
  const payloadFiles = files.filter((file) => file.path !== "portable-manifest.json");
  const manifest = portableBundleManifestSchema.parse(
    JSON.parse(Buffer.from(manifestFile.bytes).toString("utf8")) as unknown,
  );
  const expected = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
  const observed = [...payloadFiles].sort((left, right) => left.path.localeCompare(right.path));
  if (expected.length !== observed.length)
    throw new Error("portable bundle manifest file count changed");
  for (const [index, file] of observed.entries()) {
    const record = expected[index];
    if (record === undefined) throw new Error("portable bundle manifest file count changed");
    if (
      record.path !== file.path ||
      record.byteLength !== file.bytes.byteLength ||
      record.fingerprint !== byteFingerprint(file.bytes)
    ) {
      throw new Error("portable bundle manifest does not bind exact file bytes");
    }
  }
  return { manifest, files: payloadFiles };
}

export async function extractPortableBundle(
  value: Uint8Array,
  destination: string,
): Promise<PortableBundleManifest> {
  const bundle = decodePortableBundle(value);
  const root = resolve(destination);
  await assertSafeDirectoryPath(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertSafeDirectoryPath(root);
  for (const file of bundle.files) {
    const target = resolve(root, ...file.path.split("/"));
    const relativeTarget = relative(root, target);
    if (
      relativeTarget.length === 0 ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget)
    ) {
      throw new Error("portable bundle path escaped its destination");
    }
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await assertSafeDirectoryPath(parent);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, 0o600);
  }
  return bundle.manifest;
}

async function collectDirectoryFiles(root: string, current: string): Promise<PortableBundleFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: PortableBundleFile[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    const status = await lstat(path);
    if (status.isSymbolicLink()) throw new Error("portable directory contains a symbolic link");
    if (status.isDirectory()) {
      files.push(...(await collectDirectoryFiles(root, path)));
      continue;
    }
    if (!status.isFile()) throw new Error("portable directory contains a non-file entry");
    const relativePath =
      resolve(root) === resolve(path) ? "" : relative(root, path).split(sep).join("/");
    if (relativePath.length === 0) throw new Error("portable directory file path is empty");
    files.push({ path: assertPortablePath(relativePath), bytes: await readFile(path) });
  }
  return files;
}

export async function createPortableBundleFromDirectory(options: {
  readonly directory: string;
  readonly releaseId: string;
  readonly productVersion: string;
  readonly engineReleaseId: string;
  readonly engineReleaseFingerprint: string;
  readonly sourceCommit: string;
}): Promise<Uint8Array> {
  const root = await realpath(options.directory);
  await assertSafeDirectoryPath(root);
  return createPortableBundle({
    releaseId: options.releaseId,
    productVersion: options.productVersion,
    engineReleaseId: options.engineReleaseId,
    engineReleaseFingerprint: options.engineReleaseFingerprint,
    sourceCommit: options.sourceCommit,
    files: await collectDirectoryFiles(root, root),
  });
}

export function portableBundleFingerprint(value: Uint8Array): Fingerprint {
  return sha256Fingerprint(value);
}
