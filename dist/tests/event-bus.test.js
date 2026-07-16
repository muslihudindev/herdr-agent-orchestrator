"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const EventBus_1 = require("../packages/event-bus/src/EventBus");
(0, node_test_1.default)("publishes events to typed and wildcard subscribers", () => {
    const bus = new EventBus_1.EventBus();
    const seen = [];
    bus.subscribe("TaskReceived", (event) => seen.push(event.type));
    bus.subscribe("*", (event) => seen.push(`all:${event.type}`));
    bus.publish("TaskReceived", { request: "hello" });
    strict_1.default.deepEqual(seen, ["TaskReceived", "all:TaskReceived"]);
    strict_1.default.equal(bus.getHistory().length, 1);
});
