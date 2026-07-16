"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = void 0;
const node_events_1 = require("node:events");
const ids_1 = require("../../shared/src/ids");
class EventBus {
    emitter = new node_events_1.EventEmitter();
    history = [];
    publish(type, payload, workerId) {
        const event = {
            id: (0, ids_1.createId)("evt"),
            type,
            timestamp: new Date().toISOString(),
            workerId,
            payload
        };
        this.history.push(event);
        this.emitter.emit(type, event);
        this.emitter.emit("*", event);
        return event;
    }
    subscribe(type, handler) {
        this.emitter.on(type, handler);
        return () => this.emitter.off(type, handler);
    }
    getHistory() {
        return [...this.history];
    }
}
exports.EventBus = EventBus;
