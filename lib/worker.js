"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worker_communication_1 = require("worker-communication");
const cluster_ipc_logger_1 = require("cluster-ipc-logger");
const stream_1 = require("stream");
const fs = require("fs");
const PATH = require("path");
const tar = require("tar-fs");
const crypto = require("crypto");
const regex = require("simple-regex-toolkit");
__dirname = PATH.join(__dirname, '../');
process.on('SIGINT', () => { });
const cpc = new worker_communication_1.default(), log = new cluster_ipc_logger_1.loggerClient({
    system: 'worker',
    cluster: process.env.workerId
});
cpc.onMaster('decrypt', async (req, res) => {
    log.info(`Decrypting & extracting file... [${formatPath(req.input)}]`);
    try {
        const head = await readHead(req.input), decipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(req.passwordHash), head.prefix.encryptedPrivateKey.slice(-12)).setAuthTag(head.prefix.encryptedPrivateKey.slice(-28, -12)), privateKey = crypto.createPrivateKey({
            key: Buffer.concat([decipher.update(head.prefix.encryptedPrivateKey.slice(0, -28)), decipher.final()]),
            format: 'pem',
            passphrase: req.passwordHash
        }), key = crypto.privateDecrypt(privateKey, head.prefix.encryptedPassword), input = PATH.parse(req.input), output = PATH.join(input.dir, input.name), outputStream = head.prefix.isFile ? fs.createWriteStream(output) : tar.extract(output);
        outputStream.on('finish', res);
        fs.createReadStream(req.input, { start: head.prefix.length, end: head.bytesLength - 16 - 1 })
            .pipe(crypto.createDecipheriv('aes-256-gcm', key, head.prefix.iv).setAuthTag(head.suffix))
            .pipe(outputStream);
    }
    catch (err) {
        log.debug(err);
        res(err);
    }
}).onMaster('backup', async (req, res) => {
    log.info(`Syncing & encrypting ... [${formatPath(req.input)}]`);
    const l = req.output.length, name = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 255) + '.backup', isFile = await new Promise((resolve) => {
        fs.stat(req.input, (err, stats) => {
            if (err)
                return res(err);
            resolve(stats.isFile());
        });
    });
    let writeStream, outputs = [], bytes = 0;
    for (let i = l; i--;)
        outputs.push(fs.createWriteStream(PATH.join(req.output[i], name + '.temp')));
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    writeStream = new stream_1.Writable({
        write(chunk, encoding, next) {
            bytes += chunk.length;
            for (let i = l; i--;)
                outputs[i].write(chunk);
            next();
        }
    }).on('finish', () => {
        const authTag = cipher.getAuthTag();
        bytes += authTag.length;
        let promises = [];
        for (let i = l; i--;)
            promises.push(new Promise((resolve, reject) => outputs[i].end(authTag, () => fs.rename(PATH.join(req.output[i], name + '.temp'), PATH.join(req.output[i], name), (err) => {
                if (err)
                    return reject(err);
                resolve();
            }))));
        Promise.all(promises).then(() => res(null, bytes)).catch(res);
    });
    const buffers = [Buffer.from(isFile ? 'F' : 'D'), iv, crypto.publicEncrypt(req.publicKey, key), Buffer.from(req.privateKey, 'hex')];
    writeStream.write(Buffer.concat([
        Buffer.from('[' + buffers.map((b) => { return b.length; }).join(',') + ']', 'utf8'),
        ...buffers
    ]), err => {
        if (err)
            return res(err);
        if (isFile)
            fs.createReadStream(req.input).on('error', res).pipe(cipher).pipe(writeStream);
        else
            tar.pack(req.input, {
                ignore: (file) => {
                    const arr = file.split(PATH.sep);
                    for (let i = req.ignore.length; i--;) {
                        const reg = regex.from(req.ignore[i]);
                        if (reg.test(file) || arr.indexOfRegex(reg) > -1)
                            return true;
                    }
                    return false;
                },
                strict: false,
                //@ts-ignore, see: https://github.com/cloudron-io/tar-fs/commit/c941c1e364f5345686f92656238a1f8ce67232f3
                ignoreFileRemoved: (path, err) => {
                    if (err.code === 'ENOENT')
                        return true;
                    return false;
                }
            }).on('error', res).pipe(cipher).pipe(writeStream);
    });
});
function readHead(path) {
    return new Promise(async (resolve, reject) => {
        let head = {};
        try {
            head.lengthMap = await new Promise((resolve, reject) => {
                let buffer, index = -1;
                const lookingFor = Buffer.from(']'), readStream = fs.createReadStream(path, { highWaterMark: 64 }).on('data', data => {
                    if (!buffer)
                        buffer = data;
                    else
                        buffer = Buffer.concat([buffer, data]);
                    index = buffer.indexOf(lookingFor);
                    if (index > -1)
                        readStream.close();
                }).on('close', () => {
                    if (index === -1)
                        return reject(`Prefix not found`);
                    const lengthMap = splitBuffer(buffer.slice(1, index), ',').map(b => {
                        return parseInt(b);
                    });
                    if (lengthMap.length !== 4)
                        return reject(`Invalid prefix`);
                    resolve(lengthMap);
                });
            });
            head.bytesLength = await new Promise((resolve, reject) => fs.stat(path, (err, stats) => {
                if (err)
                    return reject(err);
                resolve(stats.size);
            }));
            head.prefix = await new Promise((resolve, reject) => {
                fs.open(path, 'r', (err, fd) => {
                    if (err)
                        return reject(err);
                    const indexMapLength = head.lengthMap.join(',').length + 2, prefixLength = head.lengthMap.reduce((a, b) => a + b);
                    fs.read(fd, Buffer.alloc(prefixLength), 0, prefixLength, indexMapLength, (err, bytesLength, buffer) => {
                        if (err)
                            return reject(err);
                        let prefix = {
                            isFile: null,
                            iv: buffer.slice(head.lengthMap[0], head.lengthMap[0] + head.lengthMap[1]),
                            encryptedPassword: buffer.slice(head.lengthMap[0] + head.lengthMap[1], head.lengthMap[0] + head.lengthMap[1] + head.lengthMap[2]),
                            encryptedPrivateKey: buffer.slice(head.lengthMap[0] + head.lengthMap[1] + head.lengthMap[2], head.lengthMap[0] + head.lengthMap[1] + head.lengthMap[2] + head.lengthMap[3]),
                            length: indexMapLength + prefixLength
                        };
                        const type = buffer.slice(0, head.lengthMap[0]).toString('utf8');
                        switch (type) {
                            case 'D':
                                prefix.isFile = false;
                                break;
                            case 'F':
                                prefix.isFile = true;
                                break;
                            default:
                                return reject('Unknown type');
                        }
                        fs.read(fd, Buffer.alloc(16), 0, 16, head.bytesLength - 16, (err, bytesLength, buffer) => {
                            if (err)
                                return reject(err);
                            head.suffix = buffer;
                            resolve(prefix);
                        });
                    });
                });
            });
        }
        catch (err) {
            return reject(err);
        }
        resolve(head);
    });
}
function splitBuffer(buffer, split) {
    let search = -1, lines = [];
    while ((search = buffer.indexOf(split)) > -1) {
        lines.push(buffer.slice(0, search));
        buffer = buffer.slice(search + split.length);
    }
    lines.push(buffer);
    return lines;
}
/* function getHead(path: string) {
    return new Promise<Head>((resolve, reject) => {
        fs.stat(path, (err, stats) => {
            if (err) return reject(err);
            const from = stats.size - 16;

            fs.open(path, 'r', (err, fd) => {
                if (err) return reject(err);
                let prefix = Buffer.alloc(525),
                    suffix = Buffer.alloc(16);

                fs.read(fd, prefix, 0, 525, 0, err => {
                    if (err) return reject(err);

                    fs.read(fd, suffix, 0, 16, from, err => {
                        if (err) return reject(err);

                        let head: Head = {
                            iv: prefix.slice(1, 13),
                            isFile: null,
                            encrypted: prefix.slice(13),
                            authTag: suffix,
                            end: from
                        }

                        switch (prefix.slice(0, 1).toString('utf8')) {
                            case 'D':
                                head.isFile = false;
                                break;
                            case 'F':
                                head.isFile = true;
                                break;
                            default:
                                return reject(`Unknown type`);
                        }
                        resolve(head);
                    });
                });
            });
        });
    });
} */
function formatPath(p, max = 30) {
    const l = p.length;
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(-Math.floor(n));
    }
    return p;
}
function hashPassword(p, salt = '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8') {
    return crypto.createHash('sha256').update(p + salt).digest();
}
