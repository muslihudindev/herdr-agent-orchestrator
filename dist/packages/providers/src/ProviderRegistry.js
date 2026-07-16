"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderRegistry = void 0;
const ProcessProvider_1 = require("./ProcessProvider");
const SimulatedProvider_1 = require("./SimulatedProvider");
class ProviderRegistry {
    providers = new Map();
    factories = new Map();
    constructor() {
        this.registerFactory("simulated", (name, config) => new SimulatedProvider_1.SimulatedProvider(name, config));
        this.registerFactory("process", (name, config) => new ProcessProvider_1.ProcessProvider(name, config));
    }
    registerFactory(type, factory) {
        this.factories.set(type, factory);
    }
    configure(configs) {
        for (const [name, config] of Object.entries(configs)) {
            const factory = this.factories.get(name) ?? this.factories.get("process");
            if (!factory)
                throw new Error(`No provider factory available for ${name}`);
            this.providers.set(name, factory(name, config));
        }
    }
    get(name) {
        const provider = this.providers.get(name);
        if (!provider)
            throw new Error(`Provider not registered: ${name}`);
        return provider;
    }
    list() {
        return [...this.providers.values()];
    }
}
exports.ProviderRegistry = ProviderRegistry;
