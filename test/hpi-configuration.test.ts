import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HPI_DISCLOSURE_VERSION,
  acknowledgeProviderDisclosure,
  assertHpiRuntimePathsSafe,
  createDefaultHpiConfiguration,
  hpiConfigurationSchema,
  loadHpiConfiguration,
  providerDisclosureCategories,
  providerDisclosureRequired,
  prepareHpiRuntimeDirectories,
  resolveHpiPaths,
  saveHpiConfiguration,
} from "@hunter-pi/pi-host";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const createdRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createProfile(): Promise<string> {
  const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-config-test-");
  createdRoots.push(root);
  return root;
}

describe("Hunter Pi isolated configuration", () => {
  it("stores strict product configuration outside raw Pi without changing raw Pi bytes", async () => {
    const profile = await createProfile();
    const rawPiDirectory = join(profile, ".pi");
    const rawPiSettings = join(rawPiDirectory, "settings.json");
    const rawBytes = Buffer.from('{"theme":"raw-pi-user-theme"}\n', "utf8");
    await mkdir(rawPiDirectory);
    await writeFile(rawPiSettings, rawBytes);

    const paths = resolveHpiPaths({ env: {}, homeDirectory: profile });
    expect(paths.root).toBe(join(profile, ".hunter-pi"));
    expect(paths.piAgentDirectory).toBe(join(profile, ".hunter-pi", "engine", "agent"));
    expect(paths.sessionDirectory).toBe(join(profile, ".hunter-pi", "sessions"));

    const configuration = createDefaultHpiConfiguration();
    await saveHpiConfiguration(paths, configuration);

    expect(await loadHpiConfiguration(paths)).toEqual(configuration);
    expect(await readFile(rawPiSettings)).toEqual(rawBytes);
    expect(JSON.parse(await readFile(paths.configurationFile, "utf8"))).toEqual(configuration);
  });

  it("supports an absolute test/portable root override and rejects a relative escape", async () => {
    const profile = await createProfile();
    const explicitRoot = join(profile, "portable-hpi");

    expect(
      resolveHpiPaths({
        env: { HUNTER_PI_HOME: explicitRoot },
        homeDirectory: homedir(),
      }).root,
    ).toBe(explicitRoot);
    expect(() =>
      resolveHpiPaths({ env: { HUNTER_PI_HOME: "..\\shared" }, homeDirectory: profile }),
    ).toThrow(/absolute/iu);
  });

  it("rejects linked roots and hard-linked credential leaves before reading isolated state", async () => {
    const profile = await createProfile();
    const paths = resolveHpiPaths({ env: {}, homeDirectory: profile });
    const outsideRoot = join(profile, "outside-root");
    await mkdir(outsideRoot);
    await writeFile(
      join(outsideRoot, "config.json"),
      `${JSON.stringify(createDefaultHpiConfiguration())}\n`,
      "utf8",
    );
    await symlink(outsideRoot, paths.root, process.platform === "win32" ? "junction" : "dir");
    await expect(loadHpiConfiguration(paths)).rejects.toThrow(/physical/iu);

    const secondProfile = await createProfile();
    const secondPaths = resolveHpiPaths({ env: {}, homeDirectory: secondProfile });
    await prepareHpiRuntimeDirectories(secondPaths);
    const outsideCredential = join(secondProfile, "outside-auth.json");
    await writeFile(outsideCredential, "{}\n", "utf8");
    await link(outsideCredential, join(secondPaths.piAgentDirectory, "auth.json"));
    await expect(assertHpiRuntimePathsSafe(secondPaths)).rejects.toThrow(/single-link/iu);
  });

  it("rejects linked or hard-linked entries anywhere in the isolated Pi runtime tree", async () => {
    const linkedProfile = await createProfile();
    const linkedPaths = resolveHpiPaths({ env: {}, homeDirectory: linkedProfile });
    await prepareHpiRuntimeDirectories(linkedPaths);
    const outsideDirectory = join(linkedProfile, "outside-runtime");
    await mkdir(outsideDirectory);
    await symlink(
      outsideDirectory,
      join(linkedPaths.piAgentDirectory, "nested-runtime"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(assertHpiRuntimePathsSafe(linkedPaths)).rejects.toThrow(/runtime tree/iu);

    const hardLinkedProfile = await createProfile();
    const hardLinkedPaths = resolveHpiPaths({ env: {}, homeDirectory: hardLinkedProfile });
    await prepareHpiRuntimeDirectories(hardLinkedPaths);
    const outsideSettings = join(hardLinkedProfile, "outside-settings.json");
    await writeFile(outsideSettings, "{}\n", "utf8");
    await link(outsideSettings, join(hardLinkedPaths.piAgentDirectory, "settings.json"));
    await expect(assertHpiRuntimePathsSafe(hardLinkedPaths)).rejects.toThrow(/single-link/iu);
  });

  it("requires a matching versioned disclosure acknowledgement before provider send", () => {
    const initial = createDefaultHpiConfiguration();

    expect(initial.provider.id).toBe("openai-codex");
    expect(initial.permissionProfile).toBe("BALANCED");
    expect(initial.disclosure.version).toBe(HPI_DISCLOSURE_VERSION);
    expect(initial.disclosure.categories).toEqual(providerDisclosureCategories);
    expect(providerDisclosureRequired(initial)).toBe(true);

    const acknowledged = acknowledgeProviderDisclosure(initial, {
      acceptedAt: "2026-08-03T12:00:00.000Z",
      resolvedDestinationOrigin: "https://provider-managed.example",
    });
    expect(providerDisclosureRequired(acknowledged)).toBe(false);
    expect(acknowledged.disclosure.acknowledgement).toMatchObject({
      resolvedDestinationOrigin: "https://provider-managed.example",
      externalRetention: "NOT_PROVEN",
      trainingUse: "NOT_PROVEN",
      accountControls: "PROVIDER_OWNED",
    });

    const changedProvider = {
      ...acknowledged,
      provider: {
        ...acknowledged.provider,
        id: "anthropic",
      },
    };
    expect(providerDisclosureRequired(changedProvider)).toBe(true);

    const changedPolicyReference = {
      ...acknowledged,
      provider: {
        ...acknowledged.provider,
        policyReference: "https://example.invalid/changed-policy",
      },
    };
    expect(providerDisclosureRequired(changedPolicyReference)).toBe(true);

    expect(
      providerDisclosureRequired({
        ...acknowledged,
        disclosure: { ...acknowledged.disclosure, externalRetention: "ACCOUNT_POLICY" },
      }),
    ).toBe(true);

    const localProvider = acknowledgeProviderDisclosure(
      {
        ...createDefaultHpiConfiguration(),
        provider: {
          id: "local-fixture",
          selectedModel: "fixture-model",
          endpointCategory: "LOCAL",
          destinationOrigin: "http://127.0.0.1:43123",
          policyReference: "https://example.invalid/local-policy",
        },
      },
      {
        acceptedAt: "2026-08-03T12:00:00.000Z",
        resolvedDestinationOrigin: "http://127.0.0.1:43123",
      },
    );
    expect(providerDisclosureRequired(localProvider)).toBe(false);
    expect(
      providerDisclosureRequired({
        ...localProvider,
        provider: {
          ...localProvider.provider,
          destinationOrigin: "http://127.0.0.1:43124",
        },
      }),
    ).toBe(true);
    expect(() =>
      hpiConfigurationSchema.parse({
        ...localProvider,
        provider: {
          ...localProvider.provider,
          destinationOrigin: "ftp://localhost",
        },
      }),
    ).toThrow();
  });

  it("rejects credential-like or unknown fields instead of persisting them", () => {
    const configuration = createDefaultHpiConfiguration();

    expect(() =>
      hpiConfigurationSchema.parse({
        ...configuration,
        provider: {
          ...configuration.provider,
          policyReference: "https://user:secret@example.invalid/policy?token=secret",
        },
      }),
    ).toThrow();
    for (const policyReference of [
      "https://example.invalid/policy\nFORGED",
      "https://example.invalid/policy\u001b[31m",
      "https://example.invalid/policy#secret-value",
      "file:///C:/Users/fixture/private-policy.txt",
      "javascript:alert(1)",
      "data:text/plain,policy",
    ]) {
      expect(() =>
        hpiConfigurationSchema.parse({
          ...configuration,
          provider: { ...configuration.provider, policyReference },
        }),
      ).toThrow();
    }
    for (const selectedModel of [
      "gpt-5.6-sol,anthropic/*",
      "gpt-*",
      "model?fallback",
      "model[12]",
    ]) {
      expect(() =>
        hpiConfigurationSchema.parse({
          ...configuration,
          provider: { ...configuration.provider, selectedModel },
        }),
      ).toThrow();
    }
    for (const selectedModel of [
      "@cf/meta/llama-3.3-70b",
      "anthropic.claude-v1:0",
      "model~stable",
    ]) {
      expect(
        hpiConfigurationSchema.parse({
          ...configuration,
          provider: { ...configuration.provider, selectedModel },
        }).provider.selectedModel,
      ).toBe(selectedModel);
    }

    expect(() =>
      hpiConfigurationSchema.parse({
        ...configuration,
        apiKey: "must-not-be-stored",
      }),
    ).toThrow();
    expect(() =>
      hpiConfigurationSchema.parse({
        ...configuration,
        provider: {
          ...configuration.provider,
          selectedModel: "model\nterminal-injection",
        },
      }),
    ).toThrow();
    expect(() =>
      hpiConfigurationSchema.parse({
        ...configuration,
        provider: {
          ...configuration.provider,
          cookie: "must-not-be-stored",
        },
      }),
    ).toThrow();
  });
});
