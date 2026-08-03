import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

interface ProbeModel {
  readonly id: string;
}

interface ProbeSessionEntry {
  readonly type: string;
  readonly customType?: string;
}

interface ProbeSessionManager {
  getCwd(): string;
  getEntries(): ProbeSessionEntry[];
}

interface ProbeSession {
  readonly modelRuntime: {
    getAvailable(provider: string): Promise<ProbeModel[]>;
  };
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  bindExtensions(bindings: Record<string, never>): Promise<void>;
  dispose(): void;
  prompt(
    message: string,
    options: { expandPromptTemplates: boolean; source: "rpc" },
  ): Promise<void>;
  setModel(model: ProbeModel): Promise<unknown>;
  subscribe(listener: (event: { readonly type: string }) => void): () => void;
}

interface ProbeSessionResult {
  readonly session: ProbeSession;
  readonly extensionsResult: { readonly errors: unknown[] };
}

interface PiSdkRuntime {
  readonly DefaultResourceLoader: new (options: Record<string, unknown>) => {
    reload(): Promise<void>;
  };
  readonly SessionManager: {
    create(cwd: string, sessionDirectory: string): ProbeSessionManager;
    open(sessionFile: string, sessionDirectory: string, cwdOverride?: string): ProbeSessionManager;
  };
  readonly SettingsManager: {
    inMemory(settings: Record<string, unknown>, options: { projectTrusted: boolean }): unknown;
  };
  readonly createAgentSession: (options: Record<string, unknown>) => Promise<ProbeSessionResult>;
}

const piSdkSpecifier = ["@earendil-works", "pi-coding-agent"].join("/");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
  (await import(piSdkSpecifier)) as unknown as PiSdkRuntime;

const [phase, repository, agentDirectory, sessionDirectory, coreExtensionPath, statePath] =
  process.argv.slice(2);
if (
  (phase !== "create" && phase !== "resume") ||
  repository === undefined ||
  agentDirectory === undefined ||
  sessionDirectory === undefined ||
  coreExtensionPath === undefined ||
  statePath === undefined
) {
  throw new Error("SDK probe child requires a phase and isolated fixture paths");
}

const createResources = async () => {
  const settingsManager = SettingsManager.inMemory(
    {
      defaultProvider: "hunter-pi-probe",
      defaultModel: "probe-model",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: repository,
    agentDir: agentDirectory,
    settingsManager,
    additionalExtensionPaths: [coreExtensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
};

const inspectContainedSessionFile = async (sessionFile: string): Promise<string> => {
  const [canonicalDirectory, canonicalFile] = await Promise.all([
    realpath(sessionDirectory),
    realpath(sessionFile),
  ]);
  const relativeFile = relative(canonicalDirectory, canonicalFile);
  if (
    relativeFile.length === 0 ||
    relativeFile === ".." ||
    relativeFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeFile)
  ) {
    throw new Error("SDK Session file escaped its isolated directory");
  }
  const entry = await lstat(canonicalFile);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error("SDK Session file must be a regular single-link file");
  }
  return canonicalFile;
};

const pathsMatch = async (left: string, right: string): Promise<boolean> =>
  (await realpath(left)) === (await realpath(right));

if (phase === "create") {
  const resources = await createResources();
  const manager = SessionManager.create(repository, sessionDirectory);
  const created = await createAgentSession({
    cwd: repository,
    agentDir: agentDirectory,
    resourceLoader: resources.resourceLoader,
    settingsManager: resources.settingsManager,
    sessionManager: manager,
    tools: ["hunter_pi_probe_tool"],
  });
  if (created.extensionsResult.errors.length > 0) {
    throw new Error("Core Extension failed to load in the SDK create probe");
  }
  await created.session.bindExtensions({});
  const probeModel = (await created.session.modelRuntime.getAvailable("hunter-pi-probe")).find(
    (model) => model.id === "probe-model",
  );
  if (probeModel === undefined) {
    throw new Error("Core Extension probe model was not available after SDK binding");
  }
  await created.session.setModel(probeModel);

  const eventTypes: string[] = [];
  const unsubscribe = created.session.subscribe((event) => {
    eventTypes.push(event.type);
  });
  await created.session.prompt("Run the provider-independent SDK probe.", {
    expandPromptTemplates: false,
    source: "rpc",
  });
  const sessionFile = created.session.sessionFile;
  const sessionId = created.session.sessionId;
  unsubscribe();
  created.session.dispose();
  if (sessionFile === undefined) {
    throw new Error("SDK create probe did not persist a Session");
  }
  const canonicalSessionFile = await inspectContainedSessionFile(sessionFile);
  const workspaceCwdBound = await pathsMatch(manager.getCwd(), repository);
  if (!workspaceCwdBound) {
    throw new Error("SDK create Session did not bind the fixture repository cwd");
  }
  await writeFile(
    statePath,
    `${JSON.stringify({ sessionFile: canonicalSessionFile, sessionId })}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      phase,
      processId: process.pid,
      sessionCreated: sessionId.length > 0,
      eventTypes: [...new Set(eventTypes)].sort(),
      sessionContained: true,
      sessionPersisted: true,
      workspaceCwdBound,
    })}\n`,
  );
} else {
  const rawState = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  if (
    typeof rawState !== "object" ||
    rawState === null ||
    !("sessionFile" in rawState) ||
    typeof rawState.sessionFile !== "string" ||
    !("sessionId" in rawState) ||
    typeof rawState.sessionId !== "string"
  ) {
    throw new Error("SDK resume probe state is invalid");
  }
  await inspectContainedSessionFile(rawState.sessionFile);
  const openedManager = SessionManager.open(rawState.sessionFile, sessionDirectory);
  const workspaceCwdBound = await pathsMatch(openedManager.getCwd(), repository);
  const customEntryRecovered = openedManager
    .getEntries()
    .some((entry) => entry.type === "custom" && entry.customType === "hunter-pi/core-probe-state");
  const resources = await createResources();
  const resumed = await createAgentSession({
    cwd: repository,
    agentDir: agentDirectory,
    resourceLoader: resources.resourceLoader,
    settingsManager: resources.settingsManager,
    sessionManager: openedManager,
    tools: ["hunter_pi_probe_tool"],
  });
  if (resumed.extensionsResult.errors.length > 0) {
    throw new Error("Core Extension failed to reload in the SDK resume probe");
  }
  await resumed.session.bindExtensions({});
  const sameSessionIdOnResume = resumed.session.sessionId === rawState.sessionId;
  resumed.session.dispose();
  process.stdout.write(
    `${JSON.stringify({
      phase,
      processId: process.pid,
      sameSessionIdOnResume,
      customEntryRecovered,
      workspaceCwdBound,
    })}\n`,
  );
}
