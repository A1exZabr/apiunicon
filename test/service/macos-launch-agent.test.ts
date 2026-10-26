import { describe, expect, it } from "vitest";

import {
  renderLaunchAgent,
  retryLaunchdBootstrap,
  SERVICE_LABEL,
  serviceLanguage,
  setupNotice,
  waitUntilUnloaded,
} from "../../scripts/macos-service.js";

describe("macOS launch agent", () => {
  it("retries launchd input/output errors before succeeding", () => {
    let attempts = 0;
    const pauses: number[] = [];

    retryLaunchdBootstrap(
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Bootstrap failed: 5: Input/output error");
      },
      (milliseconds) => pauses.push(milliseconds),
    );

    expect(attempts).toBe(2);
    expect(pauses).toEqual([250]);
  });

  it("does not hide non-transient launchd failures", () => {
    let attempts = 0;

    expect(() =>
      retryLaunchdBootstrap(
        () => {
          attempts += 1;
          throw new Error("Bootstrap failed: 122: Path had bad ownership/permissions");
        },
        () => undefined,
      ),
    ).toThrow("Path had bad ownership/permissions");
    expect(attempts).toBe(1);
  });

  it("runs the production server directly and keeps managed state outside the checkout", () => {
    const plist = renderLaunchAgent({
      label: SERVICE_LABEL,
      nodePath: "/opt/homebrew/bin/node",
      cliPath: "/Users/example/Projects/Tools & APIs/dist/src/cli.js",
      workingDirectory: "/Users/example/Projects/Tools & APIs",
      stateDirectory: "/Users/example/.apiunicon",
      stdoutPath: "/Users/example/.apiunicon/logs/service.out.log",
      stderrPath: "/Users/example/.apiunicon/logs/service.err.log",
    });

    expect(plist).toContain("<key>Label</key>\n  <string>online.apiunicon.connector</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/Users/example/Projects/Tools &amp; APIs/dist/src/cli.js</string>");
    expect(plist).toContain("<key>APIUNICON_HOME</key>");
    expect(plist).toContain("<string>/Users/example/.apiunicon</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toContain("/bin/sh");
  });

  it("passes the installing shell's language to the service, and nothing when there is none", () => {
    const configuration = {
      label: SERVICE_LABEL,
      nodePath: "/opt/homebrew/bin/node",
      cliPath: "/Users/example/apiunicon/dist/src/cli.js",
      workingDirectory: "/Users/example/apiunicon",
      stateDirectory: "/Users/example/.apiunicon",
      stdoutPath: "/Users/example/.apiunicon/logs/service.out.log",
      stderrPath: "/Users/example/.apiunicon/logs/service.err.log",
    };

    expect(renderLaunchAgent({ ...configuration, language: "ru_RU.UTF-8" })).toContain("<key>LANG</key>\n    <string>ru_RU.UTF-8</string>");
    expect(renderLaunchAgent(configuration)).not.toContain("<key>LANG</key>");
  });

  describe("the language written into the service", () => {
    const failing = () => {
      throw new Error("defaults failed");
    };

    it("falls back to the macOS system locale when the shell has none", () => {
      expect(serviceLanguage({}, () => "ru_RU")).toBe("ru_RU.UTF-8");
      expect(serviceLanguage({ LANG: "" }, () => "ru_RU\n")).toBe("ru_RU.UTF-8");
      expect(serviceLanguage({ LC_ALL: "", LC_MESSAGES: "", LANG: "" }, () => "en_US")).toBe("en_US.UTF-8");
      // A region override is a keyword of the locale, not part of its language.
      expect(serviceLanguage({}, () => "en_US@rg=gbzzzz")).toBe("en_US.UTF-8");
    });

    it.each(["C", "POSIX", "C.UTF-8", "POSIX.UTF-8", "C.utf8"])("treats %s as no language at all", (neutral) => {
      expect(serviceLanguage({ LANG: neutral }, () => "ru_RU")).toBe("ru_RU.UTF-8");
      expect(serviceLanguage({ LC_ALL: neutral, LANG: "" }, () => "ru_RU")).toBe("ru_RU.UTF-8");
      expect(serviceLanguage({ LC_ALL: neutral, LC_MESSAGES: "C", LANG: "POSIX" }, () => "ru_RU")).toBe("ru_RU.UTF-8");
    });

    it("keeps a language the shell names, and does not even ask the system", () => {
      expect(serviceLanguage({ LANG: "en_US.UTF-8" }, failing)).toBe("en_US.UTF-8");
      expect(serviceLanguage({ LC_ALL: "de_DE.UTF-8", LANG: "ru_RU.UTF-8" }, failing)).toBe("de_DE.UTF-8");
      // One that is set and not neutral is a choice, wherever it sits: the shell's own order decides.
      expect(serviceLanguage({ LC_ALL: "C", LANG: "ru_RU.UTF-8" }, () => "ru_RU")).toBe("C");
    });

    it("leaves things as they were when the system cannot say", () => {
      expect(serviceLanguage({}, failing)).toBeUndefined();
      expect(serviceLanguage({ LANG: "C.UTF-8" }, failing)).toBe("C.UTF-8");
      expect(serviceLanguage({ LC_ALL: "POSIX", LANG: "C" }, failing)).toBe("POSIX");
      for (const answer of ["", "  ", "(null)", "ru_RU; rm -rf /", "<ru>", "ru_RU.UTF-8", "Russian"]) {
        expect(serviceLanguage({ LANG: "C" }, () => answer), answer).toBe("C");
      }
    });
  });

  it("waits until launchd has unloaded the running service before loading it again", () => {
    const states = [true, true, false];
    const pauses: number[] = [];

    waitUntilUnloaded(() => states.shift() ?? false, (milliseconds) => pauses.push(milliseconds));

    expect(pauses).toEqual([250, 250]);
  });

  it("gives up waiting after the attempts run out", () => {
    expect(() => waitUntilUnloaded(() => true, () => {}, 3)).toThrow(/still loaded/u);
  });

  describe("the setup link the installer prints", () => {
    it("gives the link while there is no administrator, and nothing once there is", () => {
      const link = `http://127.0.0.1:3210/setup?t=${"T".repeat(43)}`;

      expect(setupNotice(() => `${link}\n`)).toBe(`Create the administrator password: ${link}\n`);
      expect(setupNotice(() => "")).toBe("");
    });

    it("does not fail the installation when the link cannot be read, and says how to print it", () => {
      const notice = setupNotice(() => {
        throw new Error("node exited with 1");
      });

      expect(notice).toContain("node exited with 1");
      expect(notice).toContain("npm run --silent setup-link");
    });
  });
});
