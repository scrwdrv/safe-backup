import CPC from 'worker-communication';
import { loggerClient } from 'cluster-ipc-logger';
import { Writable } from 'stream';
import * as fs from 'fs';
import * as PATH from 'path';
import * as tar from 'tar-fs';
import * as crypto from 'crypto';
import * as regex from 'simple-regex-toolkit';

process.on('SIGINT', () => { });

type Prefix = {
    isFile: boolean;
    iv: Buffer;
    encryptedPassword: Buffer;
    encryptedPrivateKey: Buffer;
    length: number;
};

type Head = {
    lengthMap: number[];
    bytesLength: number;
    prefix: Prefix;
    suffix: Buffer;
};

const cpc = new CPC(),
    log = new loggerClient({
        system: 'worker',
        cluster: process.env.workerId,
        debug: false
    });

cpc.onMaster('decrypt', async (req: DecryptOptions, res) => {

    log.info(`Decrypting & extracting file... [${formatPath(req.input)}]`);

    try {

        const head = await readHead(req.input),
            decipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(req.passwordHash), head.prefix.encryptedPrivateKey.slice(-12)).setAuthTag(head.prefix.encryptedPrivateKey.slice(-28, -12)),
            privateKey = crypto.createPrivateKey({
                key: Buffer.concat([decipher.update(head.prefix.encryptedPrivateKey.slice(0, -28)), decipher.final()]),
                format: 'pem',
                passphrase: req.passwordHash
            }),
            key = crypto.privateDecrypt(privateKey, head.prefix.encryptedPassword),
            input = PATH.parse(req.input),
            output = PATH.join(input.dir, input.name),
            outputStream = head.prefix.isFile ? fs.createWriteStream(output) : tar.extract(output);

        outputStream.on('finish', res);

        fs.createReadStream(req.input, { start: head.prefix.length, end: head.bytesLength - 16 - 1 })
            .pipe(crypto.createDecipheriv('aes-256-gcm', key, head.prefix.iv).setAuthTag(head.suffix))
            .pipe(outputStream);

    } catch (err) {
        log.debug(err);
        res(err);
    }

}).onMaster('backup', async (req: BackupOptions, res) => {

    const isFile = await new Promise<boolean>((resolve: (isFile: boolean) => void) => {
        fs.stat(req.input, (err, stats) => {
            if (err) return res(err);
            resolve(stats.isFile());
        });
    });

    log.info(`Syncing & encrypting ${isFile ? 'file' : 'folder'}... [${formatPath(req.input)}]`);

    try {

        const l = req.output.length,
            name = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 255) + '.backup',
            key = crypto.randomBytes(32),
            iv = crypto.randomBytes(12),
            cipher = crypto.createCipheriv('aes-256-gcm', key, iv),
            buffers = [Buffer.from(isFile ? 'F' : 'D'), iv, crypto.publicEncrypt(req.publicKey, key), Buffer.from(req.privateKey, 'hex')],
            writeStream = new Writable({
                write(chunk, encoding, next) {
                    bytesLength += chunk.length;
                    for (let i = l; i--;) outputs[i].write(chunk);
                    next();
                }
            }).on('finish', () => {
                const authTag = cipher.getAuthTag();
                let promises = [];

                bytesLength += authTag.length;

                for (let i = l; i--;)
                    promises.push(new Promise<void>((resolve, reject) =>
                        outputs[i].end(authTag, () =>
                            fs.rename(PATH.join(req.output[i], name + '.temp'), PATH.join(req.output[i], name), (err) => {
                                if (err) return reject(err)
                                resolve()
                            })
                        )
                    ));

                Promise.all(promises).then(() => res(null, bytesLength)).catch(res);
            }),
            regs = req.ignore.map(str => {
                return regex.from(str)
            });

        let outputs: fs.WriteStream[] = [],
            bytesLength = 0;

        for (let i = l; i--;)
            outputs.push(fs.createWriteStream(PATH.join(req.output[i], name + '.temp')));

        writeStream.write(Buffer.concat([
            Buffer.from('[' + buffers.map((b) => { return b.length }).join(',') + ']', 'utf8'),
            ...buffers
        ]), err => {
            if (err) return res(err), writeStream.destroy();
            if (isFile) fs.createReadStream(req.input).pipe(cipher).pipe(writeStream);
            else tar.pack(req.input, {
                ignore: (file) => {
                    const arr = file.split(PATH.sep);
                    for (let i = regs.length; i--;)
                        if (regs[i].test(file) || arr.indexOfRegex(regs[i]) > -1) return true;
                    return false;
                },
                strict: false,
                //@ts-ignore, see: https://github.com/cloudron-io/tar-fs/commit/c941c1e364f5345686f92656238a1f8ce67232f3
                ignoreFileRemoved: (path: string, err: NodeJS.ErrnoException) => {
                    if (err.code === 'ENOENT') return true;
                    return false;
                }
            }).pipe(cipher).pipe(writeStream);
        });
    } catch (err) {
        log.debug(err);
        res(err);
    }

});

function readHead(path: string) {
    return new Promise<Head>(async (resolve, reject) => {

        let head: Head = {} as any;

        try {

            head.lengthMap = await new Promise<number[]>((resolve, reject) => {

                let buffer: Buffer,
                    index = -1;

                const lookingFor = Buffer.from(']'),
                    readStream = fs.createReadStream(path, { highWaterMark: 64 }).on('data', data => {
                        if (!buffer) buffer = data;
                        else buffer = Buffer.concat([buffer, data]);
                        index = buffer.indexOf(lookingFor);
                        if (index > -1) readStream.close();
                    }).on('close', () => {

                        if (index === -1) return reject(`Prefix not found`);

                        const lengthMap = splitBuffer(buffer.slice(1, index), ',').map(b => {
                            return parseInt(b);
                        });

                        if (lengthMap.length !== 4) return reject(`Invalid prefix`);
                        resolve(lengthMap);
                    })
            });

            head.bytesLength = await new Promise<number>((resolve, reject) => fs.stat(path, (err, stats) => {
                if (err) return reject(err);
                resolve(stats.size);
            }));

            head.prefix = await new Promise<Prefix>((resolve, reject) => {
                fs.open(path, 'r', (err, fd) => {
                    if (err) return reject(err);

                    const indexMapLength = head.lengthMap.join(',').length + 2,
                        prefixLength = head.lengthMap.reduce((a, b) => a + b);

                    fs.read(fd, Buffer.alloc(prefixLength), 0, prefixLength, indexMapLength, (err, bytesLength, buffer) => {
                        if (err) return reject(err);

                        let prefix: Prefix = {
                            isFile: null,
                            iv: buffer.slice(head.lengthMap[0], head.lengthMap[0] + head.lengthMap[1]),
                            encryptedPassword: buffer.slice(head.lengthMap[0] + head.lengthMap[1], head.lengthMap[0] + head.lengthMap[1] + head.lengthMap[2]),
                            encryptedPrivateKey: buffer.slice(head.lengthMap[0] + head.lengthMap[1] + head.lengthMap[2], head.lengthMap[0] + head.lengthMap[1] + head.lengthMap[2] + head.lengthMap[3]),
                            length: indexMapLength + prefixLength
                        }

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
                            if (err) return reject(err);
                            head.suffix = buffer;
                            resolve(prefix);
                        });
                    });
                });
            });

        } catch (err) {
            return reject(err)
        }

        resolve(head);

    });
}

function hashPassword(p: string, salt = '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8') {
    return crypto.createHash('sha256').update(p + salt).digest();
}

function splitBuffer(buffer: Buffer, split: Buffer | string) {
    let search = -1, lines = [];

    while ((search = buffer.indexOf(split)) > -1) {
        lines.push(buffer.slice(0, search));
        buffer = buffer.slice(search + split.length);
    }

    lines.push(buffer);
    return lines;
}

function formatPath(p: string, max: number = 30) {
    const l = p.length
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(- Math.floor(n));
    }
    return p;
}