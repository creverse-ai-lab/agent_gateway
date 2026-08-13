import assert from "node:assert/strict";
import test from "node:test";
import { buildReport, FLOW_NAMES, measurePayloads, readBaseline } from "../scripts/bench-payload.js";

// The benchmark is a report, not a budget: this test guards that every flow
// still gets measured, never that a flow stayed under some size.
test("payload benchmark measures every representative Main flow", async () => {
  const flows = await measurePayloads();
  assert.deepEqual(Object.keys(flows), [...FLOW_NAMES]);
  for (const name of FLOW_NAMES) {
    assert.ok(Number.isInteger(flows[name]), `${name} must report an integer byte count`);
    assert.ok(flows[name] > 0, `${name} must report a positive byte count`);
  }

  const withoutBaseline = buildReport(flows, null);
  assert.equal(withoutBaseline.baseline, null);
  assert.equal(withoutBaseline.deltaPct, null);
  assert.deepEqual(withoutBaseline.flows, flows);

  const report = buildReport(flows, { flows });
  assert.deepEqual(Object.keys(report.deltaPct), [...FLOW_NAMES]);
  for (const name of FLOW_NAMES) assert.equal(report.deltaPct[name], 0);
});

test("payload baseline fixture covers the same flows as the benchmark", async () => {
  const baseline = await readBaseline();
  assert.ok(baseline, "test/fixtures/payload-baseline.json must be committed");
  assert.deepEqual(Object.keys(baseline.flows).sort(), [...FLOW_NAMES].sort());
  for (const name of FLOW_NAMES) assert.ok(baseline.flows[name] > 0);
});
