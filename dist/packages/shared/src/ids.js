"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createId = createId;
const node_crypto_1 = require("node:crypto");
function createId(prefix) {
    return `${prefix}-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
}
