// `next build` with a neutral HOME for Node File Tracing.
//
// Routes under src/app/api/cli-tools/* read config paths from
// os.homedir()/APPDATA/LOCALAPPDATA with dynamic segments (per-tool config
// files, browser profile scans). @vercel/nft — which Next.js runs during a
// production build for `output: "standalone"` — cannot resolve those dynamic
// segments statically, so it falls back to globbing the *build machine's* home
// directory. On a dev machine that walk can take minutes (tens of thousands of
// readdirs) and, worse, dies with EPERM on the first file whose ACL denies
// readlink (sandbox-created files, some vendor caches) — killing the build.
//
// Tracing against an empty home keeps the trace bounded and stable. Runtime is
// unaffected: the routes still read the real home when the server runs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const fakeHome = mkdtempSync(path.join(os.tmpdir(), "9router-build-home-"));
mkdirSync(path.join(fakeHome, "AppData", "Roaming"), { recursive: true });
mkdirSync(path.join(fakeHome, "AppData", "Local"), { recursive: true });
mkdirSync(path.join(fakeHome, ".config"), { recursive: true });

const env = {
  ...process.env,
  USERPROFILE: fakeHome,
  APPDATA: path.join(fakeHome, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
  XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
};
// On POSIX, os.homedir() reads HOME; on Windows it reads USERPROFILE.
if (process.platform !== "win32") env.HOME = fakeHome;

// The webpack production build peaks above Node's default ~4GB heap on a full
// app build; without this it dies with "JavaScript heap out of memory".
// Appended (not replaced) so an explicit user NODE_OPTIONS still wins.
const heapFlag = "--max-old-space-size=8192";
env.NODE_OPTIONS = env.NODE_OPTIONS?.includes("--max-old-space-size")
  ? env.NODE_OPTIONS
  : `${env.NODE_OPTIONS || ""} ${heapFlag}`.trim();

let status = 1;
try {
  const nextBin = require.resolve("next/dist/bin/next", { paths: [projectRoot] });
  const result = spawnSync(process.execPath, [nextBin, "build", ...process.argv.slice(2)], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  status = result.status ?? 1;
} finally {
  rmSync(fakeHome, { recursive: true, force: true });
}

process.exit(status);
