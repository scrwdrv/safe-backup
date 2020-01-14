"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_communication_1 = require("worker-communication");
const cluster_ipc_logger_1 = require("cluster-ipc-logger");
const stream_1 = require("stream");
const folderEncrypt = require("folder-encrypt");
const fs = require("fs");
const PATH = require("path");
const cpc = new worker_communication_1.default(), log = new cluster_ipc_logger_1.loggerClient({
    system: 'worker',
    cluster: process.env.workerId
});
cpc.onMaster('decrypt', (req, res) => {
    log.info(`Decrypting... [${formatPath(req.input)}]`);
    folderEncrypt.decrypt({
        input: req.input,
        password: req.passwordHash
    }).then(res).catch(res);
}).onMaster('backup', (req, res) => {
    log.info(`Syncing... [${formatPath(req.input)}]`);
    const l = req.output.length, name = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 255) + '.backup';
    let writeStream, outputs = [], bytes = 0;
    for (let i = l; i--;)
        outputs.push(fs.createWriteStream(PATH.join(req.output[i], name)));
    writeStream = new stream_1.Writable({
        write(chunk, encoding, next) {
            bytes += chunk.length;
            for (let i = l; i--;)
                outputs[i].write(chunk);
            next();
        }
    }).on('finish', () => {
        for (let i = l; i--;)
            outputs[i].end();
    });
    folderEncrypt.encrypt({
        input: req.input,
        password: req.passwordHash,
        output: writeStream
    }).then(() => res(null, bytes)).catch(res);
});
function formatPath(p, max = 30) {
    const l = p.length;
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(-Math.floor(n));
    }
    return p;
}
process.on('SIGINT', () => { });
