import { z } from "zod";

const compilerConfigurationSchema = z.looseObject({
  compilerOptions: z.looseObject({
    exactOptionalPropertyTypes: z.literal(true),
    isolatedModules: z.literal(true),
    module: z.literal("NodeNext"),
    moduleResolution: z.literal("NodeNext"),
    noUncheckedIndexedAccess: z.literal(true),
    strict: z.literal(true),
    verbatimModuleSyntax: z.literal(true),
  }),
});
const packageManifestSchema = z.looseObject({
  type: z.literal("module"),
});

/**
 * @param {unknown} compilerConfiguration root compiler configuration.
 * @param {unknown} packageManifest root package manifest.
 * @returns {void}
 */
export const assertStrictCompilerPolicy = (compilerConfiguration, packageManifest) => {
  compilerConfigurationSchema.parse(compilerConfiguration);
  packageManifestSchema.parse(packageManifest);
};
