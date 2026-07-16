"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const HerdRAdapter_1 = require("../packages/runtime/src/HerdRAdapter");
(0, node_test_1.default)("parses HerdR pane id from documented pane_split response", () => {
    strict_1.default.equal((0, HerdRAdapter_1.parsePaneId)(JSON.stringify({ result: { pane: { pane_id: "wC:p2" } } })), "wC:p2");
});
(0, node_test_1.default)("parses HerdR pane id from alternate id response", () => {
    strict_1.default.equal((0, HerdRAdapter_1.parsePaneId)(JSON.stringify({ result: { pane: { id: "1-2" } } })), "1-2");
});
(0, node_test_1.default)("parses HerdR agent id from agent start response", () => {
    strict_1.default.equal((0, HerdRAdapter_1.parseAgentId)(JSON.stringify({ result: { agent: { terminal_id: "wC:p9" } } })), "wC:p9");
});
(0, node_test_1.default)("returns undefined for non-json output", () => {
    strict_1.default.equal((0, HerdRAdapter_1.parsePaneId)("not json"), undefined);
});
(0, node_test_1.default)("parses agent status from pane get response", () => {
    const stdout = JSON.stringify({ result: { pane: { pane_id: "wC:p2", agent_status: "idle" } } });
    strict_1.default.equal((0, HerdRAdapter_1.parseAgentStatus)(stdout, "wC:p2"), "idle");
});
(0, node_test_1.default)("parses agent status from nested pane list response", () => {
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
    strict_1.default.equal((0, HerdRAdapter_1.parseAgentStatus)(stdout, "wC:p2"), "done");
});
