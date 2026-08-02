import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["src/head-transition/**/*.test.ts"], {
  dir: "src",
  includeOpenClawRuntimeSetup: false,
  name: "head-transition-light",
  passWithNoTests: true,
});
