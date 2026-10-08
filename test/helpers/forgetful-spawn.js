// Test-only, loaded into a daemon with `--import ./test/helpers/forgetful-spawn.js`.
// Every spawn drops the env it was given, as a spawn that forgot the child-env
// helper would, so its child inherits the daemon's own process.env. What such a
// child can see is then exactly what the daemon kept in its environment.
//
// Patching the CommonJS export and syncing the builtin ESM bindings before the
// daemon's module graph loads is what makes `import { spawn }` in src/ resolve
// to the wrapper (the same approach as fault-fs.js).
import { createRequire, syncBuiltinESMExports } from "node:module";

const childProcess = createRequire(import.meta.url)("child_process");
const spawn = childProcess.spawn;

childProcess.spawn = function forgetfulSpawn(command, args, options) {
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const { env: _forgotten, ...rest } = options;
    return spawn.call(this, command, args, rest);
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
