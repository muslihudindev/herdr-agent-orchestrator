import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../packages/event-bus/src/EventBus";

test("publishes events to typed and wildcard subscribers", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe("TaskReceived", (event) => seen.push(event.type));
  bus.subscribe("*", (event) => seen.push(`all:${event.type}`));

  bus.publish("TaskReceived", { request: "hello" });

  assert.deepEqual(seen, ["TaskReceived", "all:TaskReceived"]);
  assert.equal(bus.getHistory().length, 1);
});
