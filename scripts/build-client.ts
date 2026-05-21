// Delegates to the client package's `build` task (Tauri build via npm:).
const ROOT = new URL("..", import.meta.url).pathname;

const cmd = new Deno.Command("deno", {
  args: ["task", "build"],
  cwd: `${ROOT}packages/tomat-client`,
  stdout: "inherit",
  stderr: "inherit",
});
const { code } = await cmd.output();
Deno.exit(code);
