"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const folderEncrypt = require("folder-encrypt");
const cluster_ipc_logger_1 = require("cluster-ipc-logger");
const worker_communication_1 = require("worker-communication");
const log = new cluster_ipc_logger_1.loggerClient({
    system: 'worker', cluster: process.env.workerId
}), cpc = new worker_communication_1.default();
cpc.onMaster('backup', (req, res) => {
});
log.info(`Worker[${process.env.workerId}] initialized`);
class Backup {
    constructor() {
        this.options = {};
    }
    copy() {
    }
    encrypt(input) {
        folderEncrypt.encrypt({
            input: input,
            password: this.options.password
        });
    }
}
