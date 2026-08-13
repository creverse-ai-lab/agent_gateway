import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES as internalCodes, GatewayError as InternalGatewayError } from "../src/errors.js";
import { GatewayRpcClient as InternalGatewayRpcClient } from "../src/socket-rpc.js";
import { GATEWAY_API_VERSION as internalApiVersion } from "../src/version.js";
import { PUBLIC_CLIENT_EXPORTS } from "../scripts/runtime-release-lib.js";
import * as publicClient from "acp-gateway/client";

test("the public client entrypoint exposes the complete consumer contract", () => {
  assert.deepEqual(Object.keys(publicClient).sort(), [...PUBLIC_CLIENT_EXPORTS]);
  assert.equal(publicClient.GatewayRpcClient, InternalGatewayRpcClient);
  assert.equal(publicClient.GatewayError, InternalGatewayError);
  assert.equal(publicClient.ERROR_CODES, internalCodes);
  assert.equal(publicClient.GATEWAY_API_VERSION, internalApiVersion);
});

test("package exports reject private Gateway subpaths", async () => {
  await assert.rejects(
    import("acp-gateway/src/socket-rpc.js"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
});
