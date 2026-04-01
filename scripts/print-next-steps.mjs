import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const version = pkg.version;

process.stdout.write(
  [
    `Version ${version} is ready.`,
    "Release steps:",
    "1. git add .",
    `2. git commit -m "release: v${version}"`,
    `3. git tag v${version}`,
    "4. git push origin main --follow-tags"
  ].join("\n") + "\n"
);
