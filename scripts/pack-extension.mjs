/**
 * 将 extension/ 打包为根目录 neuroflow-link-extension.zip
 * 用法: npm run pack:extension
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const extDir = join(root, "extension");
const outZip = join(root, "neuroflow-link-extension.zip");

if (!existsSync(extDir)) {
  console.error("extension/ 目录不存在");
  process.exit(1);
}

if (process.platform === "win32") {
  const ps = `
    if (Test-Path '${outZip.replace(/'/g, "''")}') { Remove-Item '${outZip.replace(/'/g, "''")}' -Force }
    Compress-Archive -Path '${join(extDir, "*").replace(/'/g, "''")}' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force
  `;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", ps],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
} else {
  // Unix: zip 命令
  const r = spawnSync(
    "zip",
    ["-r", "-j", outZip, ...readdirSync(extDir).map((f) => join(extDir, f))],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    // 回退到 tar
    const r2 = spawnSync("tar", ["-a", "-cf", outZip, "-C", extDir, "."], {
      encoding: "utf8",
    });
    if (r2.status !== 0) {
      console.error("请安装 zip，或手动压缩 extension/ 目录");
      process.exit(1);
    }
  }
}

const size = statSync(outZip).size;
console.log(`已生成: ${outZip} (${size} bytes)`);
console.log("包含文件:", readdirSync(extDir).join(", "));
