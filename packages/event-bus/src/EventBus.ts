import { EventEmitter } from "node:events";
import { createId } from "../../shared/src/ids";
import { PlatformEvent, PlatformEventType } from "../../shared/src/types";

export type EventHandler<TPayload = unknown> = (event: PlatformEvent<TPayload>) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: PlatformEvent[] = [];

  publish<TPayload>(type: PlatformEventType, payload: TPayload, workerId?: string): PlatformEvent<TPayload> {
    const event: PlatformEvent<TPayload> = {
      id: createId("evt"),
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

  subscribe<TPayload>(type: PlatformEventType | "*", handler: EventHandler<TPayload>): () => void {
    this.emitter.on(type, handler as EventHandler);
    return () => this.emitter.off(type, handler as EventHandler);
  }

  getHistory(): PlatformEvent[] {
    return [...this.history];
  }
}
