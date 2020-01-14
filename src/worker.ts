import CPC from 'worker-communication';
import { loggerClient } from 'cluster-ipc-logger';
import { Writable } from 'stream';
import * as folderEncrypt from 'folder-encrypt';
import * as fs from 'fs';
import * as PATH from 'path';

const cpc = new CPC(),
    log = new loggerClient({
        system: 'worker',
        cluster: process.env.workerId
    });

cpc.onMaster('decrypt', (req: DecryptOptions, res) => {
    log.info(`Decrypting... [${formatPath(req.input)}]`);

    folderEncrypt.decrypt({
        input: req.input,
        password: req.passwordHash
    }).then(res).catch(res);

}).onMaster('backup', (req: BackupOptions, res) => {
    log.info(`Syncing... [${formatPath(req.input)}]`)

    const l = req.output.length,
        name = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 255) + '.backup';

    let writeStream: Writable,
        outputs: fs.WriteStream[] = [],
        bytes = 0;

    for (let i = l; i--;)
        outputs.push(fs.createWriteStream(PATH.join(req.output[i], name)));

    writeStream = new Writable({
        write(chunk, encoding, next) {
            bytes += chunk.length;
            for (let i = l; i--;) outputs[i].write(chunk);
            next();
        }
    }).on('finish', () => {
        for (let i = l; i--;) outputs[i].end();
    });

    folderEncrypt.encrypt({
        input: req.input,
        password: req.passwordHash,
        output: writeStream
    }).then(() => res(null, bytes)).catch(res);
});

function formatPath(p: string, max: number = 30) {
    const l = p.length
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(- Math.floor(n));
    }
    return p;
}

process.on('SIGINT', () => { });