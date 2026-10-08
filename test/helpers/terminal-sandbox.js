import { detectTerminalSandbox } from "../../src/terminal-sandbox.js";

// For tests about what a Gateway terminal does (its env, its lifecycle, the
// string checks), not about the sandbox it runs in. Since 1.8.0 auto_approve
// starts a terminal on its own only where an OS sandbox keeps it off the
// protected paths, so without one these tests would stop at a permission
// request. Where this OS has the sandbox (macOS) they run under it; elsewhere
// under a stand-in that runs the command as given.
export const terminalSandboxOrStandIn = detectTerminalSandbox() ?? {
  ready: async () => true,
  wrap: (command, args) => ({ command, args })
};
