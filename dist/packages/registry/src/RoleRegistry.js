"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoleRegistry = void 0;
class RoleRegistry {
    config;
    constructor(config) {
        this.config = config;
    }
    get(role) {
        return this.config.roles[role];
    }
    providerFor(role) {
        return this.get(role).provider;
    }
    replicasFor(role) {
        return this.get(role).replicas;
    }
}
exports.RoleRegistry = RoleRegistry;
