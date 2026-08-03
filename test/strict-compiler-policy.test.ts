import { describe, expect, it } from "vitest";

import { assertStrictCompilerPolicy } from "../scripts/strict-compiler-policy.mjs";

const validCompilerConfiguration = () => ({
  compilerOptions: {
    exactOptionalPropertyTypes: true,
    isolatedModules: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    noUncheckedIndexedAccess: true,
    strict: true,
    verbatimModuleSyntax: true,
  },
});

describe("strict compiler policy", () => {
  it("accepts the required strict NodeNext ESM configuration", () => {
    expect(() => {
      assertStrictCompilerPolicy(validCompilerConfiguration(), {
        type: "module",
      });
    }).not.toThrow();
  });

  it.each([
    "exactOptionalPropertyTypes",
    "isolatedModules",
    "noUncheckedIndexedAccess",
    "strict",
    "verbatimModuleSyntax",
  ] as const)("rejects %s when it is disabled", (option) => {
    const configuration = validCompilerConfiguration();

    expect(() => {
      assertStrictCompilerPolicy(
        {
          compilerOptions: {
            ...configuration.compilerOptions,
            [option]: false,
          },
        },
        { type: "module" },
      );
    }).toThrow();
  });

  it("rejects a non-NodeNext module or resolution mode", () => {
    const configuration = validCompilerConfiguration();

    expect(() => {
      assertStrictCompilerPolicy(
        {
          compilerOptions: {
            ...configuration.compilerOptions,
            module: "ESNext",
          },
        },
        { type: "module" },
      );
    }).toThrow();
    expect(() => {
      assertStrictCompilerPolicy(
        {
          compilerOptions: {
            ...configuration.compilerOptions,
            moduleResolution: "Bundler",
          },
        },
        { type: "module" },
      );
    }).toThrow();
  });

  it("rejects a root package that is not ESM", () => {
    expect(() => {
      assertStrictCompilerPolicy(validCompilerConfiguration(), {
        type: "commonjs",
      });
    }).toThrow();
  });
});
