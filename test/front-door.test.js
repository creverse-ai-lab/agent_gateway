import assert from "node:assert/strict";
import test from "node:test";
import { staleFrontDoorNotice } from "../src/front-door.js";

const paths = { adminScript: "/opt/acp/src/admin.js", socketPath: "/tmp/acp-gateway-501.sock" };

test("staleFrontDoor tells an older daemon to restart when idle, not to reconnect", () => {
  const notice = staleFrontDoorNotice("1.6.0", "1.5.2", paths);
  assert.deepEqual(Object.keys(notice), ["frontDoorVersion", "gatewayVersion", "reason", "action"]);
  assert.equal(notice.frontDoorVersion, "1.6.0");
  assert.equal(notice.gatewayVersion, "1.5.2");
  assert.equal(notice.reason, "gateway_older");
  assert.equal(
    notice.action,
    "restart the gateway daemon when idle: run `acp-gateway-admin shutdown_if_idle` "
      + "(without that command on PATH: `node /opt/acp/src/admin.js shutdown_if_idle`); "
      + "it refuses while work is in flight, so retry later. The next agent-acp call then starts 1.6.0"
  );
  assert.doesNotMatch(notice.action, /reconnect/);
  // Numeric order, not string order.
  assert.equal(staleFrontDoorNotice("1.10.0", "1.9.3", paths).reason, "gateway_older");
});

test("staleFrontDoor gives a daemon without shutdown_if_idle a stop it understands", () => {
  const notice = staleFrontDoorNotice("1.6.0", "1.4.0", paths);
  assert.equal(notice.reason, "gateway_older");
  assert.equal(
    notice.action,
    "restart the gateway daemon when idle: it predates shutdown_if_idle, so as a last resort: confirm no worker is busy "
      + "and that `ps -p $(cat /tmp/acp-gateway-501.sock.lock) -o command=` shows gateway-daemon.js, "
      + "then run `kill $(cat /tmp/acp-gateway-501.sock.lock)`, which unlike shutdown_if_idle is not idle-safe; "
      + "if another app manages the daemon (e.g. a menu-bar monitor), stop or restart it there instead. "
      + "The next agent-acp call then starts 1.6.0"
  );
  const spaced = staleFrontDoorNotice("1.6.0", "1.5.0", { ...paths, adminScript: "/Users/me/App Support/src/admin.js" });
  assert.match(spaced.action, /`node '\/Users\/me\/App Support\/src\/admin\.js' shutdown_if_idle`/);
  assert.match(staleFrontDoorNotice("1.6.0", "1.5.0").action, /node \S*admin\.js shutdown_if_idle/);
});

test("staleFrontDoor keeps reconnect for an older front door and for labels that do not order", () => {
  assert.deepEqual(staleFrontDoorNotice("1.5.2", "1.6.0", paths), {
    frontDoorVersion: "1.5.2",
    gatewayVersion: "1.6.0",
    reason: "front_door_older",
    action: "reconnect the agent-acp MCP server"
  });
  for (const [frontDoor, gateway] of [["1.6.0", "dev"], ["main", "1.6.0"], ["1.6.0-rc.1", "1.6.0"]]) {
    assert.deepEqual(staleFrontDoorNotice(frontDoor, gateway, paths), {
      frontDoorVersion: frontDoor,
      gatewayVersion: gateway,
      action: "reconnect the agent-acp MCP server"
    });
  }
  assert.equal(staleFrontDoorNotice("1.6.0", "1.6.0", paths), null);
  assert.equal(staleFrontDoorNotice("1.6.0", null, paths), null);
});
