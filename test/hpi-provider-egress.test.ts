import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  acknowledgeProviderDisclosure,
  createDefaultHpiConfiguration,
  createPiLaunchPlan,
  prepareHpiRuntimeDirectories,
  resolveBundledPiCliPath,
  resolveHpiPaths,
  resolvePiProviderDestination,
} from "@hunter-pi/pi-host";
import { runCapturedProcess, runCapturedRpcCommand } from "./support/captured-process.js";
import { createTemporaryTestDirectory } from "./support/temporary-test-directory.js";

const createdRoots: string[] = [];
const providerFixtureProcessTimeoutMs = 15_000;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

const fakeEndpointReceiptSchema = z.strictObject({
  schemaVersion: z.literal("hpi-provider-egress-fixture.v1"),
  destinationMatched: z.literal(true),
  requestCount: z.literal(1),
  requestPath: z.literal("/v1/chat/completions"),
  authorizationPresent: z.boolean(),
  payloadCategories: z.strictObject({
    PROMPTS: z.literal(true),
    CONVERSATION_CONTEXT: z.literal(true),
    REPOSITORY_CONTENT: z.literal(false),
    TOOL_RESULTS: z.literal(false),
    REQUEST_METADATA: z.literal(true),
  }),
  cancellationBeforeSendRequestCount: z.literal(0),
  mismatchedDestinationRequestCount: z.literal(0),
  rawCredentialCaptured: z.literal(false),
});

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

describe("Hunter Pi Provider egress gate", () => {
  it("proves cancellation, exact local destination, payload accounting, and credential-safe Evidence", async () => {
    const root = await createTemporaryTestDirectory(tmpdir(), "hunter-pi-egress-test-");
    createdRoots.push(root);
    const repository = join(root, "repository");
    const coreExtensionPath = fileURLToPath(
      new URL("../packages/pi-host/src/core-extension.ts", import.meta.url),
    );
    await mkdir(repository);
    const gitInitialization = spawnSync(
      "git",
      ["-C", repository, "init", "--quiet", "--initial-branch=fixture"],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
    expect(gitInitialization.status, gitInitialization.stderr).toBe(0);
    const contextSentinel = "unsafe-global-context-must-not-load";
    await writeFile(join(repository, "AGENTS.md"), `${contextSentinel}\n`, "utf8");

    const credentialSentinel = "fixture-credential-must-not-enter-evidence";
    const requests: {
      readonly path: string;
      readonly authorizationPresent: boolean;
      readonly body: string;
    }[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        requests.push({
          path: request.url ?? "",
          authorizationPresent: request.headers.authorization !== undefined,
          body: await readRequestBody(request),
        });
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "close",
        });
        response.end(
          [
            'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":0,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"fixture-ok"},"finish_reason":null}]}',
            'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":0,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        );
      })().catch(() => {
        response.destroy();
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("fixture bind failed");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const paths = resolveHpiPaths({ env: { HUNTER_PI_HOME: join(root, "profile") } });
      await prepareHpiRuntimeDirectories(paths);
      await writeFile(
        join(paths.piAgentDirectory, "models.json"),
        `${JSON.stringify({
          providers: {
            "hunter-fixture": {
              baseUrl: `${origin}/v1`,
              api: "openai-completions",
              apiKey: credentialSentinel,
              authHeader: true,
              compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
              models: [
                {
                  id: "fixture-model",
                  name: "Fixture Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 4096,
                  maxTokens: 64,
                },
              ],
            },
          },
        })}\n`,
        "utf8",
      );

      const proposed = {
        ...createDefaultHpiConfiguration(),
        setupCompletedAt: "2026-08-03T00:00:00.000Z",
        provider: {
          id: "hunter-fixture",
          selectedModel: "fixture-model",
          endpointCategory: "LOCAL" as const,
          destinationOrigin: origin,
          policyReference: "https://example.invalid/hunter-fixture-policy",
        },
        plugins: [],
      };

      expect(() =>
        createPiLaunchPlan({
          paths,
          configuration: proposed,
          cwd: repository,
          purpose: "QUICK",
          safeMode: true,
          providerAuthConfigured: true,
          resolvedProviderDestination: { configuredOrigin: origin, pristineOrigin: null },
          sessionTreeInspected: true,
          coreExtensionPath,
        }),
      ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));
      expect(requests).toHaveLength(0);

      const configuration = acknowledgeProviderDisclosure(proposed, {
        acceptedAt: "2026-08-03T00:00:01.000Z",
        resolvedDestinationOrigin: origin,
      });
      const selectedModel = configuration.provider.selectedModel;
      if (selectedModel === null) throw new Error("fixture model selection missing");
      const resolvedDestination = await resolvePiProviderDestination(
        paths,
        configuration.provider.id,
        selectedModel,
      );
      expect(() =>
        createPiLaunchPlan({
          paths,
          configuration,
          cwd: repository,
          purpose: "QUICK",
          safeMode: true,
          providerAuthConfigured: true,
          resolvedProviderDestination: {
            configuredOrigin: "http://127.0.0.1:1",
            pristineOrigin: null,
          },
          sessionTreeInspected: true,
          coreExtensionPath,
        }),
      ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));
      expect(requests).toHaveLength(0);

      const managedPaths = resolveHpiPaths({
        env: { HUNTER_PI_HOME: join(root, "managed-profile") },
      });
      await prepareHpiRuntimeDirectories(managedPaths);
      await writeFile(
        join(managedPaths.piAgentDirectory, "models.json"),
        `${JSON.stringify({
          providers: { "openai-codex": { baseUrl: `${origin}/v1` } },
        })}\n`,
        "utf8",
      );
      const managedProposed = {
        ...createDefaultHpiConfiguration(),
        setupCompletedAt: "2026-08-03T00:00:00.000Z",
        plugins: [],
      };
      const managedModel = managedProposed.provider.selectedModel;
      if (managedModel === null) throw new Error("managed fixture model selection missing");
      const managedDestination = await resolvePiProviderDestination(
        managedPaths,
        managedProposed.provider.id,
        managedModel,
      );
      if (managedDestination.pristineOrigin === null) {
        throw new Error("managed fixture pristine origin missing");
      }
      const managedConfiguration = acknowledgeProviderDisclosure(managedProposed, {
        acceptedAt: "2026-08-03T00:00:01.000Z",
        resolvedDestinationOrigin: managedDestination.pristineOrigin,
      });
      expect(managedDestination.configuredOrigin).toBe(origin);
      expect(managedDestination.pristineOrigin).not.toBe(origin);
      expect(() =>
        createPiLaunchPlan({
          paths: managedPaths,
          configuration: managedConfiguration,
          cwd: repository,
          purpose: "QUICK",
          safeMode: true,
          providerAuthConfigured: true,
          resolvedProviderDestination: managedDestination,
          sessionTreeInspected: true,
          coreExtensionPath,
        }),
      ).toThrow(expect.objectContaining({ code: "DISCLOSURE_REQUIRED" }));
      expect(requests).toHaveLength(0);

      const safeBashPlan = createPiLaunchPlan({
        paths,
        configuration,
        cwd: repository,
        purpose: "QUICK",
        safeMode: true,
        providerAuthConfigured: true,
        resolvedProviderDestination: resolvedDestination,
        sessionTreeInspected: true,
        coreExtensionPath,
        piCliPath: resolveBundledPiCliPath(),
      });
      const safeBashEnvironment: Record<string, string> = { ...safeBashPlan.environment };
      for (const key of ["ComSpec", "LANG", "PATH", "PATHEXT", "SystemRoot", "WINDIR"]) {
        const value = process.env[key];
        if (value !== undefined) safeBashEnvironment[key] = value;
      }
      Object.assign(safeBashEnvironment, {
        HOME: root,
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        USERPROFILE: root,
      });
      const mutationPath = join(repository, "unsafe-marker.txt");
      const safeBashExecution = await runCapturedRpcCommand(
        {
          ...safeBashPlan,
          arguments: [...safeBashPlan.arguments, "--mode", "rpc", "--no-session", "--no-tools"],
          environment: safeBashEnvironment,
          label: "safe-bash-rpc",
          timeoutMs: providerFixtureProcessTimeoutMs,
        },
        {
          id: "hunter-safe-bash",
          type: "bash",
          command: `node -e "require('node:fs').writeFileSync('unsafe-marker.txt','changed')"`,
        },
      );
      expect(safeBashExecution.exitCode, safeBashExecution.stderr).toBe(0);
      expect(safeBashExecution.stdout).toContain(
        "Hunter Pi blocked direct shell execution in Safe Mode.",
      );
      await expect(access(mutationPath)).rejects.toThrow();
      expect(requests).toHaveLength(0);

      const noSendPlan = createPiLaunchPlan({
        paths,
        configuration,
        cwd: repository,
        purpose: "QUICK",
        safeMode: true,
        providerAuthConfigured: true,
        resolvedProviderDestination: resolvedDestination,
        sessionTreeInspected: true,
        blockPromptInput: true,
        coreExtensionPath,
        piCliPath: resolveBundledPiCliPath(),
      });
      const noSendEnvironment: Record<string, string> = { ...noSendPlan.environment };
      for (const key of ["ComSpec", "LANG", "PATH", "PATHEXT", "SystemRoot", "WINDIR"]) {
        const value = process.env[key];
        if (value !== undefined) noSendEnvironment[key] = value;
      }
      Object.assign(noSendEnvironment, {
        HOME: root,
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        USERPROFILE: root,
      });
      const noSendExecution = await runCapturedProcess({
        ...noSendPlan,
        arguments: [
          ...noSendPlan.arguments,
          "--mode",
          "json",
          "--no-session",
          "--no-tools",
          "blocked fixture prompt",
        ],
        environment: noSendEnvironment,
        label: "prompt-blocked-json",
        timeoutMs: providerFixtureProcessTimeoutMs,
      });
      expect(noSendExecution.exitCode, noSendExecution.stderr).toBe(0);
      expect(requests).toHaveLength(0);
      expect(`${noSendExecution.stdout}\n${noSendExecution.stderr}`).not.toContain(
        credentialSentinel,
      );

      const plan = createPiLaunchPlan({
        paths,
        configuration,
        cwd: repository,
        purpose: "QUICK",
        safeMode: true,
        providerAuthConfigured: true,
        resolvedProviderDestination: resolvedDestination,
        sessionTreeInspected: true,
        coreExtensionPath,
        piCliPath: resolveBundledPiCliPath(),
      });
      const childEnvironment: Record<string, string> = { ...plan.environment };
      for (const key of ["ComSpec", "LANG", "PATH", "PATHEXT", "SystemRoot", "WINDIR"]) {
        const value = process.env[key];
        if (value !== undefined) childEnvironment[key] = value;
      }
      Object.assign(childEnvironment, {
        HOME: root,
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        USERPROFILE: root,
      });
      const execution = await runCapturedProcess({
        ...plan,
        arguments: [
          ...plan.arguments,
          "--mode",
          "json",
          "--no-session",
          "--no-tools",
          "fixture prompt",
        ],
        environment: childEnvironment,
        label: "local-endpoint-json",
        timeoutMs: providerFixtureProcessTimeoutMs,
      });
      expect(execution.exitCode, execution.stderr).toBe(0);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (request === undefined) throw new Error("fixture request missing");
      const payload = JSON.parse(request.body) as {
        readonly model?: string;
        readonly messages?: readonly {
          readonly role?: string;
          readonly content?: unknown;
        }[];
        readonly tools?: unknown;
      };
      const roles = new Set(payload.messages?.map((message) => message.role));
      const capturedSurfaces = `${request.body}\n${execution.stdout}\n${execution.stderr}`;
      const receipt = fakeEndpointReceiptSchema.parse({
        schemaVersion: "hpi-provider-egress-fixture.v1",
        destinationMatched: resolvedDestination.configuredOrigin === origin,
        requestCount: requests.length,
        requestPath: request.path,
        authorizationPresent: request.authorizationPresent,
        payloadCategories: {
          PROMPTS: payload.messages?.some(
            (message) =>
              message.role === "user" && JSON.stringify(message.content).includes("fixture prompt"),
          ),
          CONVERSATION_CONTEXT: roles.has("system") || roles.has("developer"),
          REPOSITORY_CONTENT: false,
          TOOL_RESULTS: roles.has("tool"),
          REQUEST_METADATA: payload.model === "fixture-model",
        },
        cancellationBeforeSendRequestCount: 0,
        mismatchedDestinationRequestCount: 0,
        rawCredentialCaptured: capturedSurfaces.includes(credentialSentinel),
      });
      const evidenceText = JSON.stringify(receipt);
      expect(receipt.authorizationPresent).toBe(true);
      expect(request.body).not.toContain(credentialSentinel);
      expect(request.body).not.toContain(contextSentinel);
      expect(`${execution.stdout}\n${execution.stderr}\n${evidenceText}`).not.toContain(
        credentialSentinel,
      );
    } finally {
      await new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise();
        });
      });
    }
  }, 60_000);
});
