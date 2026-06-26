import { spawn } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2).flatMap((arg) => (arg === "--host" ? ["--hostname"] : [arg]));
const child = spawn("next", ["dev", ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
