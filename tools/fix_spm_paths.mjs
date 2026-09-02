/**
 * 修复并**校验** Capacitor CLI 在 Windows 上生成的 SPM 路径。
 *
 * 背景（踩过的坑，必读）：
 *   `npx cap sync ios` 在 Windows 会往 ios/App/CapApp-SPM/Package.swift 写入
 *     .package(name: "Xxx", path: "..\..\..\node_modules\@scope\pkg")
 *   Swift 把 \. \n \@ 等当成**非法转义序列**，本地看不出问题，
 *   一到 macOS/Xcode 编译就炸（"invalid escape sequence in literal"）。
 *   该文件标注 DO NOT MODIFY —— 每次 sync 都会重新生成，所以每次 sync 后都跑一次本脚本。
 *
 * 为什么还要校验存在性：
 *   反斜杠若被中间环节（shell 转义、编辑器）提前吃掉，路径会变成 "......" 之类，
 *   此时"没有反斜杠"反而意味着路径已损坏，纯替换检测不出来。
 *   所以修完必须逐个 stat 一遍，确保真的指向 node_modules 里的插件目录。
 *
 * 用法：node tools/fix_spm_paths.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "ios", "App", "CapApp-SPM", "Package.swift");

if (!fs.existsSync(FILE)) {
  console.error("❌ 找不到 Package.swift：" + FILE);
  process.exit(1);
}

const src = fs.readFileSync(FILE, "utf8");

/* 只改 .package(..., path: "...") 里的路径，避免误伤其他字符串 */
const fixed = src.replace(/(\.package\([^)]*?path:\s*")([^"]*)(")/g, (m, pre, p, post) => {
  const norm = p.replace(/\\/g, "/");
  return norm === p ? m : pre + norm + post;
});

if (fixed !== src) {
  fs.writeFileSync(FILE, fixed, "utf8");
  console.log("🔧 已把反斜杠路径改为正斜杠");
}

/* 逐个校验路径是否真实存在（相对 Package.swift 所在目录解析） */
const dirOfFile = path.dirname(FILE);
const re = /\.package\([^)]*?name:\s*"([^"]+)"[^)]*?path:\s*"([^"]*)"/g;
let m, bad = 0, checked = 0;
while ((m = re.exec(fixed))) {
  const [, name, p] = m;
  if (!p || p.startsWith("http")) continue; // 远程包（如 capacitor-swift-pm）跳过
  checked++;
  const abs = path.resolve(dirOfFile, p);
  const hasPkgSwift = fs.existsSync(path.join(abs, "Package.swift"));
  if (hasPkgSwift) {
    console.log("  ✅ " + name + "  →  " + p);
  } else {
    bad++;
    console.log("  ❌ " + name + "  →  " + p + "   【目录不存在或缺少 Package.swift】" + "\n     解析为：" + abs);
  }
}

if (bad) {
  console.error("\n❌ " + bad + " 个本地插件路径不可用。常见原因：");
  console.error("   1) 刚跑完 cap sync 但没执行本脚本（反斜杠问题）");
  console.error("   2) 依赖没装（先 npm install）");
  console.error("   3) 路径被意外改写（对比 git diff 确认）");
  process.exit(1);
}

console.log("\n✅ SPM 路径校验通过（" + checked + " 个本地插件）" + (fixed === src ? "，本次无需修改" : ""));
