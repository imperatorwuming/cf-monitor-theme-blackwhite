import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const release = resolve("release");
const runners = join(release, "runner");
mkdirSync(runners, { recursive: true });
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const theme = join(release, `cf-monitor-theme-blackwhite-v${version}.zip`);
const output = readdirSync("dist").sort();
if (output.join(",") !== "assets,index.html") throw new Error("主题产物只允许 index.html 和 assets/");
rmSync(theme, { force: true });
execFileSync("zip", ["-q", "-r", theme, ...output], { cwd: "dist" });

const metadataPath = "network-observatory/plugin/src/runner-release.json";
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const runnerSource = resolve("network-observatory/runner");
const tmp = mkdtempSync(join(tmpdir(), "blackwhite-release-"));
try {
  const runnerDir = join(tmp, "runner");
  mkdirSync(runnerDir);
  const runnerFiles = readdirSync(runnerSource).filter(name => /\.(py|service|timer|openrc|sh)$/.test(name));
  for (const file of runnerFiles) copyFileSync(join(runnerSource, file), join(runnerDir, file));
  copyFileSync(metadataPath, join(runnerDir, "release.json"));
  // The archive's metadata filename is part of the runner upgrade protocol.
  writeFileSync(join(tmp, "komari-plugin.json"), JSON.stringify({ short: "blackwhite-network-observatory", version: metadata.version }));
  const archive = join(runners, metadata.archive);
  rmSync(archive, { force: true });
  execFileSync("zip", ["-q", "-X", archive, "komari-plugin.json", ...runnerFiles.map(file => "runner/" + file), "runner/release.json"], { cwd: tmp });
  const latest = join(runners, "Blackwhite-Network-Observatory-latest.zip");
  const installer = join(runners, "Blackwhite-Network-Observatory-install.sh");
  copyFileSync(archive, latest);
  copyFileSync(join(runnerSource, "quick-install.sh"), installer);
  for (const path of [theme, archive, latest, installer]) {
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    writeFileSync(path + ".sha256", digest + "  " + path.split("/").at(-1) + "\n");
  }
} finally {
  rmSync(tmp, { force: true, recursive: true });
}
console.log("主题 ZIP 和探测器发布文件已写入 release/");
