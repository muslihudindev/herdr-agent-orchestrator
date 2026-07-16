import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentId, parseAgentStatus, parsePaneId } from "../packages/runtime/src/HerdRAdapter";

test("parses HerdR pane id from documented pane_split response", () => {
  assert.equal(parsePaneId(JSON.stringify({ result: { pane: { pane_id: "wC:p2" } } })), "wC:p2");
});

test("parses HerdR pane id from alternate id response", () => {
  assert.equal(parsePaneId(JSON.stringify({ result: { pane: { id: "1-2" } } })), "1-2");
});

test("parses HerdR agent id from agent start response", () => {
  assert.equal(parseAgentId(JSON.stringify({ result: { agent: { terminal_id: "wC:p9" } } })), "wC:p9");
});

test("returns undefined for non-json output", () => {
  assert.equal(parsePaneId("not json"), undefined);
});

test("parses agent status from pane get response", () => {
  const stdout = JSON.stringify({ result: { pane: { pane_id: "wC:p2", agent_status: "idle" } } });

  assert.equal(parseAgentStatus(stdout, "wC:p2"), "idle");
});

test("parses agent status from nested pane list response", () => {
  const stdout = JSON.stringify({
    result: {
      tabs: [
        {
          panes: [
            { pane_id: "wC:p1", agent_status: "working" },
            { pane_id: "wC:p2", agent_status: "done" }
          ]
        }
      ]
    }
  });

  assert.equal(parseAgentStatus(stdout, "wC:p2"), "done");
});
