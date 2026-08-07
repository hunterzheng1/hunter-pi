import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workflow = await readFile(
  resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);

describe("GitHub Actions CI efficiency policy", () => {
  it("gates the expensive containment matrix and serializes its host-sensitive jobs", () => {
    const task7Section =
      /\x20{2}task7-platform:\r?\n([\s\S]*?)\r?\n\x20{2}task7-evidence-consistency:/u.exec(
        workflow,
      )?.[1];
    const task7EvidenceSection = /\x20{2}task7-evidence-consistency:\r?\n([\s\S]*)$/u.exec(
      workflow,
    )?.[1];

    expect(task7Section).toBeDefined();
    expect(task7EvidenceSection).toBeDefined();
    expect(task7Section).toMatch(/^\x20{4}needs: quality\s*$/mu);
    expect(task7Section).toMatch(/^\x20{6}max-parallel: 1\s*$/mu);

    const task7BuildIndex = task7Section?.indexOf("run: npm run build") ?? -1;
    const task7ProbeIndex = task7Section?.indexOf("run: npm run probe:task7:compiled") ?? -1;
    const task7EvidenceBuildIndex = task7EvidenceSection?.indexOf("run: npm run build") ?? -1;
    const task7CompareIndex =
      task7EvidenceSection?.indexOf("npm run compare:task7-evidence:compiled") ?? -1;
    expect(task7BuildIndex).toBeGreaterThanOrEqual(0);
    expect(task7ProbeIndex).toBeGreaterThan(task7BuildIndex);
    expect(task7EvidenceBuildIndex).toBeGreaterThanOrEqual(0);
    expect(task7CompareIndex).toBeGreaterThan(task7EvidenceBuildIndex);
  });

  it("uses cached locked installs and avoids rebuilding the same artifact repeatedly", () => {
    const installCommands = [...workflow.matchAll(/^\s+run: npm ci[^\r\n]*$/gmu)].map(
      (match) => match[0],
    );

    expect(installCommands.length).toBeGreaterThan(0);
    expect(
      installCommands.every(
        (command) =>
          command.includes("--prefer-offline") &&
          command.includes("--no-audit") &&
          command.includes("--no-fund"),
      ),
    ).toBe(true);

    expect(workflow).toContain("run: npm run package-smoke:compiled");
    expect(workflow).toContain("run: npm run pack:preview:compiled");
    expect(workflow).toContain("run: npm run probe:pi:compiled");
    expect(workflow).toContain("run: npm run probe:task7:compiled");
    expect(workflow).toContain("npm run compare:task7-evidence:compiled");
    expect(workflow).not.toContain("name: Managed process platform tests");
    expect(workflow).not.toMatch(
      /run: npm run (package-smoke|pack:preview|probe:pi|probe:task7)(?:\s|$)/u,
    );
    expect(workflow).not.toMatch(/npm run compare:task7-evidence(?:\s|$)/u);
  });

  it("preserves and retries only structured Task 7 test-execution failures once", () => {
    const task7Section =
      /\x20{2}task7-platform:\r?\n([\s\S]*?)\r?\n\x20{2}task7-evidence-consistency:/u.exec(
        workflow,
      )?.[1];

    expect(task7Section).toMatch(/id: task7_probe/u);
    expect(task7Section).toMatch(/continue-on-error: true/u);
    expect(task7Section).toMatch(/id: task7_retry_gate/u);
    expect(task7Section).toMatch(/if: steps\.task7_probe\.outcome == 'failure'/u);
    expect(task7Section).toMatch(/receipt\.stage !== 'TEST_EXECUTION'/u);
    expect(task7Section).toMatch(/attempt-1/u);
    expect(task7Section).toMatch(/id: task7_retry/u);
    expect(task7Section).toMatch(/if: steps\.task7_retry_gate\.outcome == 'success'/u);
    expect(task7Section).toMatch(/Require a passing Task 7 receipt/u);
    expect(task7Section).toMatch(/status !== 'PASS'/u);
  });
});
