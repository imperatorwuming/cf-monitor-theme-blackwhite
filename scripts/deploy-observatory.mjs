import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../network-observatory/worker/", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const config = directory + "wrangler.toml";
const template = directory + "wrangler.example.toml";
const [provided, workerName, ...extra] = process.argv.slice(2);

function run(args, capture = false) {
  return execFileSync(process.execPath, [wrangler, ...args], {
    cwd: directory,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function configure() {
  if (!provided || extra.length) {
    throw new Error("用法：npm run observatory:cloudflare:deploy -- https://你的监控站地址 [CFSM Worker 名称]");
  }
  const origin = new URL(provided);
  if (origin.protocol !== "https:" || origin.origin !== provided) throw new Error("CF 地址需为 HTTPS origin，请省略路径、参数和结尾斜杠");
  const inferred = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/.exec(origin.hostname)?.[1];
  const upstream = workerName || inferred;
  if (upstream && (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(upstream) || upstream === "blackwhite-observatory"))
    throw new Error("CFSM Worker 名称无效");
  if (existsSync(config)) {
    const existing = readFileSync(config, "utf8");
    const configured = /^CFSM_ORIGIN\s*=\s*"([^"]+)"/m.exec(existing)?.[1];
    if (configured !== provided || existing.includes("00000000-0000-0000-0000-000000000000"))
      throw new Error("现有 wrangler.toml 的 CFSM_ORIGIN 或 D1 ID 与部署参数不符，请检查配置");
    if (upstream && !/^binding\s*=\s*"CFSM"/m.test(existing)) {
      writeFileSync(config, existing + serviceBinding(upstream));
    }
    return;
  }

  const name = "blackwhite-observatory";
  const lookup = () => JSON.parse(run(["d1", "list", "--json", "--config", template], true)).find(entry => entry.name === name);
  let database = lookup();
  if (!database) {
    run(["d1", "create", name, "--config", template]);
    database = lookup();
  }
  const id = database?.uuid || database?.id;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || "")) throw new Error("无法确认 D1 数据库 ID");
  const source = readFileSync(template, "utf8")
    .replace("00000000-0000-0000-0000-000000000000", id)
    .replace("https://your-monitor.your-account.workers.dev", origin.origin) + (upstream ? serviceBinding(upstream) : "");
  writeFileSync(config, source, { flag: "wx", mode: 0o600 });
}

function serviceBinding(worker) {
  return `\n[[services]]\nbinding = "CFSM"\nservice = "${worker}"\n`;
}

try {
  configure();
  const configuration = readFileSync(config, "utf8");
  const databaseName = /^database_name\s*=\s*"([^"]+)"/m.exec(configuration)?.[1];
  if (!databaseName) throw new Error("wrangler.toml 缺少 database_name");
  run(["d1", "migrations", "apply", databaseName, "--remote", "--config", config]);
  run(["deploy", "--config", config]);
  console.log("部署后请按网络观测 README 设置 CFSM_APP_PASSWORD、检查健康接口，并连接主题。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
