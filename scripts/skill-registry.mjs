import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv.slice(2);

if (command.length === 0) {
  console.error("用法：node scripts/skill-registry.mjs <validate|audit|shadow|activate|retire|rollback|disable|enable> [--name value]");
  process.exit(2);
}

const reportIndex = command.indexOf("--report");
if (reportIndex >= 0 && command[reportIndex + 1]) {
  command[reportIndex + 1] = path.resolve(root, command[reportIndex + 1]);
}

const result = spawnSync(
  "dotnet",
  ["run", "--project", "src/Zhaojian.Api", "--", "--skill-command", ...command],
  { cwd: root, stdio: "inherit" },
);

if (result.error) {
  console.error(`无法启动 Skill 管理命令：${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
