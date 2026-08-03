import { appendFileSync } from "node:fs";

import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const receiptPath = process.env["HUNTER_PI_PROBE_EXTENSION_RECEIPT"];
if (receiptPath === undefined) {
  throw new Error("HUNTER_PI_PROBE_EXTENSION_RECEIPT is required");
}

const record = (value: Record<string, unknown>): void => {
  appendFileSync(receiptPath, `${JSON.stringify(value)}\n`, "utf8");
};

const probeTool = defineTool({
  name: "hunter_pi_probe_tool",
  label: "Hunter Pi Probe Tool",
  description: "Provider-independent tool used only by the Hunter Pi public-interface probe.",
  parameters: Type.Object({
    value: Type.String(),
  }),
  async execute(_toolCallId, parameters) {
    record({ event: "probe_tool_execute", value: parameters.value });
    return {
      content: [{ type: "text", text: `observed:${parameters.value}` }],
      details: { observed: true },
    };
  },
});

export default function coreExtensionProbe(pi: ExtensionAPI): void {
  const responseMode = process.env["HUNTER_PI_PROBE_RESPONSE_MODE"] ?? "tool";
  const faux = fauxProvider({
    api: "hunter-pi-probe-api",
    provider: "hunter-pi-probe",
    models: [
      {
        id: "probe-model",
        name: "Hunter Pi local probe model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
    tokensPerSecond: 10_000,
    tokenSize: { min: 4, max: 4 },
  });

  if (responseMode === "wait-for-abort") {
    faux.setResponses([
      async (_context, options) => {
        record({ event: "probe_stream_waiting" });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("probe stream was not interrupted")),
            10_000,
          );
          const finish = (): void => {
            clearTimeout(timeout);
            resolve();
          };
          if (options?.signal?.aborted === true) {
            finish();
            return;
          }
          options?.signal?.addEventListener("abort", finish, { once: true });
        });
        record({ event: "probe_stream_aborted" });
        return fauxAssistantMessage("cancelled", {
          stopReason: "aborted",
          timestamp: 946_684_800_000,
        });
      },
    ]);
  } else {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "hunter_pi_probe_tool",
          { value: "provider-independent" },
          { id: "toolcall-hunter-pi-probe" },
        ),
        { timestamp: 946_684_800_000 },
      ),
      fauxAssistantMessage("probe complete", { timestamp: 946_684_800_001 }),
    ]);
  }

  pi.registerProvider(faux.provider);
  pi.registerTool(probeTool);

  record({
    event: "factory_loaded",
    coreExtensionId: "hunter-pi/core-probe",
    coreExtensionVersion: "1.0.0",
  });

  pi.on("session_start", () => {
    record({
      event: "session_start",
      coreExtensionId: "hunter-pi/core-probe",
      coreExtensionVersion: "1.0.0",
      activeTools: [...pi.getActiveTools()].sort(),
      effectiveToolGraph: pi
        .getAllTools()
        .map((tool) => ({
          name: tool.name,
          source: tool.sourceInfo.source,
          scope: tool.sourceInfo.scope,
          origin: tool.sourceInfo.origin,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
    pi.appendEntry("hunter-pi/core-probe-state", {
      coreExtensionId: "hunter-pi/core-probe",
      coreExtensionVersion: "1.0.0",
    });
  });

  for (const eventName of ["agent_start", "agent_end", "agent_settled"] as const) {
    pi.on(eventName, () => {
      record({ event: eventName });
    });
  }
  pi.on("tool_call", (event) => {
    record({ event: "tool_call", toolName: event.toolName });
  });
  pi.on("tool_result", (event) => {
    record({ event: "tool_result", toolName: event.toolName, isError: event.isError });
  });
  pi.on("session_shutdown", () => {
    record({ event: "session_shutdown" });
  });
}
