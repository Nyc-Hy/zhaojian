import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const argumentsToForward = process.argv.slice(2);
if (argumentsToForward.length === 0) argumentsToForward.push("--help");

function run(command, args = argumentsToForward) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });

  if (result.error?.code === "ENOENT") return false;
  if (result.error) {
    console.error(`Klari 启动失败：${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

const configuredCli = process.env.KLARI_CLI?.trim();
if (configuredCli) {
  if (!existsSync(configuredCli)) {
    console.error(`KLARI_CLI 指向的文件不存在：${configuredCli}`);
    process.exit(127);
  }
  run(configuredCli);
}

run("klari");

const executableName = process.platform === "win32" ? "Klari.Cli.exe" : "Klari.Cli";
const siblingCandidates = [
  path.resolve(repositoryRoot, "../klari/src/Klari.Cli/bin/Release/net10.0/publish", executableName),
  path.resolve(repositoryRoot, "../klari/src/Klari.Cli/bin/Release/net10.0", executableName),
];

for (const candidate of siblingCandidates) {
  if (existsSync(candidate)) run(candidate);
}

const siblingDll = path.resolve(repositoryRoot, "../klari/src/Klari.Cli/bin/Release/net10.0/Klari.Cli.dll");
if (existsSync(siblingDll)) run("dotnet", [siblingDll, ...argumentsToForward]);

console.error([
  "没有找到 Klari CLI。",
  "请安装 Klari.Cli、设置 KLARI_CLI=/绝对路径/klari，",
  "或把 Klari 源码仓库放在当前项目的兄弟目录 ../klari。",
].join("\n"));
process.exit(127);
