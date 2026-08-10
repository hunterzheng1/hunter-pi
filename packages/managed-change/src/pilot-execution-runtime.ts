import type { EngineHost } from "@hunter-pi/engine-contracts";

import type { RealManagedChangePilotExecutionBinding } from "./real-change.js";

const productPilotExecutionRuntimeKey = Symbol("hunter-pi.real-managed-change-pilot-runtime");

export interface RealManagedChangeProviderReservation {
  readonly requests: number;
  readonly tokens: number;
  readonly costMinor: number;
}

function parseProviderReservation(value: unknown): RealManagedChangeProviderReservation {
  if (
    typeof value !== "object" ||
    value === null ||
    !("requests" in value) ||
    !("tokens" in value) ||
    !("costMinor" in value) ||
    !Number.isSafeInteger(value.requests) ||
    !Number.isSafeInteger(value.tokens) ||
    !Number.isSafeInteger(value.costMinor) ||
    (value.requests as number) <= 0 ||
    (value.tokens as number) <= 0 ||
    (value.costMinor as number) <= 0
  ) {
    throw new Error("the pilot Provider reservation is invalid");
  }
  return Object.freeze({
    requests: value.requests as number,
    tokens: value.tokens as number,
    costMinor: value.costMinor as number,
  });
}

interface ProductPilotExecutionRuntime {
  readonly [productPilotExecutionRuntimeKey]: {
    readonly binding: RealManagedChangePilotExecutionBinding;
    readonly engineHost: EngineHost;
    readonly assertDurablePreSendRetryable: () => Promise<void>;
    readonly beforeProviderSend: () => Promise<RealManagedChangeProviderReservation>;
  };
}

export function createRealManagedChangePilotExecutionRuntime(options: {
  readonly binding: RealManagedChangePilotExecutionBinding;
  readonly engineHost: EngineHost;
  readonly assertDurablePreSendRetryable: () => Promise<void>;
  readonly beforeProviderSend: () => Promise<RealManagedChangeProviderReservation>;
}): unknown {
  let reservation: RealManagedChangeProviderReservation | undefined;
  let pendingAuthorization: Promise<RealManagedChangeProviderReservation> | undefined;
  return Object.freeze({
    [productPilotExecutionRuntimeKey]: Object.freeze({
      binding: options.binding,
      engineHost: options.engineHost,
      assertDurablePreSendRetryable: options.assertDurablePreSendRetryable,
      beforeProviderSend: async () => {
        if (reservation !== undefined) return reservation;
        pendingAuthorization ??= options.beforeProviderSend().then(parseProviderReservation);
        try {
          reservation = await pendingAuthorization;
          return reservation;
        } finally {
          if (reservation === undefined) pendingAuthorization = undefined;
        }
      },
    }),
  } satisfies ProductPilotExecutionRuntime);
}

export function realManagedChangePilotExecutionFor(
  runtime: unknown,
  engineHost: EngineHost,
):
  | {
      readonly binding: RealManagedChangePilotExecutionBinding;
      readonly assertDurablePreSendRetryable: () => Promise<void>;
      readonly beforeProviderSend: () => Promise<RealManagedChangeProviderReservation>;
    }
  | undefined {
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !(productPilotExecutionRuntimeKey in runtime)
  ) {
    return undefined;
  }
  const productRuntime = runtime as ProductPilotExecutionRuntime;
  const value = productRuntime[productPilotExecutionRuntimeKey];
  return value.engineHost === engineHost
    ? {
        binding: value.binding,
        assertDurablePreSendRetryable: value.assertDurablePreSendRetryable,
        beforeProviderSend: value.beforeProviderSend,
      }
    : undefined;
}
