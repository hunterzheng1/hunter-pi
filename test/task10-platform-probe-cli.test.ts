import { describe, expect, it } from "vitest";

import * as task10Probe from "../tools/task10-platform-probe.js";

describe("Task 10 platform probe CLI arguments", () => {
  it("uses the approved default Evidence path when no output is supplied", () => {
    expect(
      task10Probe.parseTask10OutputArgument([], ".artifacts/task10-platform/default.json"),
    ).toBe(".artifacts/task10-platform/default.json");
  });

  it("preserves an explicitly supplied output argument", () => {
    expect(task10Probe.parseTask10OutputArgument(["--output", "custom.json"], "default.json")).toBe(
      "custom.json",
    );
  });
});
