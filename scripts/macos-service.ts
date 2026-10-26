import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LaunchAgentConfiguration = {
  label: string;
  nodePath: string;
  cliPath: string;
  workingDirectory: string;
  stateDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  // The installing shell's locale. launchd starts the service without one, and the catalog's default address follows it.
  language?: string;
};

export const SERVICE_LABEL = "online.apiunicon.connector";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function servicePath(nodePath: string): string {
  return [dirname(nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(":");
}

export function renderLaunchAgent(configuration: LaunchAgentConfiguration): string {
  const path = servicePath(configuration.nodePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(configuration.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(configuration.nodePath)}</string>
    <string>${xml(configuration.cliPath)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(configuration.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>APIUNICON_HOME</key>
    <string>${xml(configuration.stateDirectory)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${xml(path)}</string>${configuration.language ? `
    <key>LANG</key>
    <string>${xml(configuration.language)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(configuration.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(configuration.stderrPath)}</string>
</dict>
</plist>
`;
}

// "C", "POSIX" and their encoded forms (C.UTF-8) name no language: they are what a shell without a locale reports.
const NEUTRAL_LOCALE = /^(?:C|POSIX)(?:\.[A-Za-z0-9-]+)?$/u;
// What `defaults read -g AppleLocale` prints, such as ru_RU or en_US@rg=gbzzzz; the keywords after @ are dropped.
const APPLE_LOCALE = /^([A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})?)(?:@.*)?$/u;

// The system's own locale, for a shell that has none. Throws when macOS does not say.
export function readAppleLocale(): string {
  const result = spawnSync("/usr/bin/defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) throw new Error("The system locale is unavailable");
  return result.stdout;
}

// The LANG the service starts with. launchd gives a service no locale, and the catalog's default cloud follows it, so
// the installer hands it the shell's: LC_ALL, LC_MESSAGES, LANG, in that order. A shell that names no language (all
// three empty, C or POSIX, as an installer started from an editor or a launcher has) says nothing about the person's,
// so the system locale stands in, as ru_RU.UTF-8. When the system cannot say, the service gets the shell's value, or
// none.
export function serviceLanguage(env: NodeJS.ProcessEnv, readSystemLocale: () => string): string | undefined {
  const shell = [env.LC_ALL, env.LC_MESSAGES, env.LANG];
  if (shell.every((value) => value === undefined || value === "" || NEUTRAL_LOCALE.test(value))) {
    try {
      const locale = APPLE_LOCALE.exec(readSystemLocale().trim())?.[1];
      if (locale) return `${locale}.UTF-8`;
    } catch {
      // Keep the shell's own answer.
    }
  }
  return shell.find((value) => value !== undefined && value !== "");
}

function servicePaths(): LaunchAgentConfiguration & { plistPath: string; serviceTarget: string; uid: number } {
  const scriptPath = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(scriptPath), "..");
  const userHome = homedir();
  const stateDirectory = join(userHome, ".apiunicon");
  const logDirectory = join(stateDirectory, "logs");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("macOS user id is unavailable");
  const language = serviceLanguage(process.env, readAppleLocale);
  return {
    label: SERVICE_LABEL,
    nodePath: process.execPath,
    cliPath: join(projectRoot, "dist", "src", "cli.js"),
    workingDirectory: projectRoot,
    stateDirectory,
    stdoutPath: join(logDirectory, "service.out.log"),
    stderrPath: join(logDirectory, "service.err.log"),
    plistPath: join(userHome, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    serviceTarget: `gui/${uid}/${SERVICE_LABEL}`,
    uid,
    ...(language ? { language } : {}),
  };
}

function launchctl(args: string[], allowFailure = false): string {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} failed`).trim());
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

// How long to wait between two looks at launchd, and how many looks it gets.
const LAUNCHD_PAUSE_MS = 250;
const BOOTSTRAP_ATTEMPTS = 5;
const UNLOAD_ATTEMPTS = 40;

export function retryLaunchdBootstrap(run: () => void, pause: (milliseconds: number) => void): void {
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      run();
      return;
    } catch (error) {
      const isTransientLaunchdError =
        error instanceof Error && error.message.includes("Bootstrap failed: 5: Input/output error");
      if (!isTransientLaunchdError || attempt === BOOTSTRAP_ATTEMPTS) throw error;
      pause(LAUNCHD_PAUSE_MS);
    }
  }
}

// bootout returns before launchd has finished unloading; loading again too early fails with "Input/output error".
export function waitUntilUnloaded(
  isLoaded: () => boolean,
  pause: (milliseconds: number) => void,
  attempts = UNLOAD_ATTEMPTS,
): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isLoaded()) return;
    pause(LAUNCHD_PAUSE_MS);
  }
  throw new Error("The previous service is still loaded; try again in a few seconds");
}

function isLoaded(target: string): boolean {
  return spawnSync("/bin/launchctl", ["print", target], { encoding: "utf8" }).status === 0;
}

const sleep = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function install(): void {
  const paths = servicePaths();
  if (!existsSync(paths.cliPath)) {
    throw new Error(`Production build is missing at ${paths.cliPath}; run npm run build first`);
  }
  mkdirSync(dirname(paths.plistPath), { recursive: true });
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 });
  chmodSync(paths.stateDirectory, 0o700);
  chmodSync(dirname(paths.stdoutPath), 0o700);

  const temporaryPath = `${paths.plistPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, renderLaunchAgent(paths), { mode: 0o600 });
  const lint = spawnSync("/usr/bin/plutil", ["-lint", temporaryPath], { encoding: "utf8" });
  if (lint.status !== 0) {
    unlinkSync(temporaryPath);
    throw new Error((lint.stderr || lint.stdout || "plutil validation failed").trim());
  }
  renameSync(temporaryPath, paths.plistPath);
  chmodSync(paths.plistPath, 0o600);

  launchctl(["bootout", paths.serviceTarget], true);
  waitUntilUnloaded(() => isLoaded(paths.serviceTarget), sleep);
  retryLaunchdBootstrap(() => launchctl(["bootstrap", `gui/${paths.uid}`, paths.plistPath]), sleep);
  launchctl(["kickstart", "-k", paths.serviceTarget]);
  process.stdout.write(`Installed and started ${paths.label}\n${paths.plistPath}\n`);
  process.stdout.write(setupNotice(() => readSetupLink(paths)));
}

// What the installer adds once the service runs: the link that creates the administrator, while there is none. A
// failure to read it does not undo the installation; the service prints the link in its log too.
export function setupNotice(readLink: () => string): string {
  let link: string;
  try {
    link = readLink().trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `The setup link could not be read (${reason}). Run npm run --silent setup-link to print it.\n`;
  }
  return link === "" ? "" : `Create the administrator password: ${link}\n`;
}

// The installed CLI prints the link itself, in the service's own environment, so the link names the service's state
// folder and port. It prints nothing once an administrator exists.
function readSetupLink(configuration: LaunchAgentConfiguration): string {
  const result = spawnSync(configuration.nodePath, [configuration.cliPath, "setup-link"], {
    cwd: configuration.workingDirectory,
    env: {
      HOME: homedir(),
      APIUNICON_HOME: configuration.stateDirectory,
      NODE_ENV: "production",
      PATH: servicePath(configuration.nodePath),
      ...(configuration.language ? { LANG: configuration.language } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error((result.stderr || `setup-link exited with ${result.status ?? "a signal"}`).trim());
  return result.stdout;
}

function uninstall(): void {
  const paths = servicePaths();
  launchctl(["bootout", paths.serviceTarget], true);
  if (existsSync(paths.plistPath)) unlinkSync(paths.plistPath);
  process.stdout.write(`Stopped and removed ${paths.label}\n`);
}

function status(): void {
  const paths = servicePaths();
  process.stdout.write(`${launchctl(["print", paths.serviceTarget])}\n`);
}

function main(): void {
  const action = process.argv[2];
  if (action === "install") install();
  else if (action === "uninstall") uninstall();
  else if (action === "status") status();
  else throw new Error("Usage: tsx scripts/macos-service.ts <install|uninstall|status>");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
