import CPC from 'worker-communication';
import { loggerClient } from 'cluster-ipc-logger';
import { Writable } from 'stream';
import * as fs from 'fs';
import * as PATH from 'path';
import * as crypto from 'crypto';
import * as regex from 'simple-regex-toolkit';
import { platform } from 'os';
import * as archive from './archive';
import * as keytar from 'keytar';

process.on('SIGINT', () => { });

type encryptHead = {
    encryptedPrivateKey: Buffer;
    encryptedKey: Buffer;
    isFile?: boolean;
}

const cpc = new CPC(),
    log = new loggerClient({
        system: 'worker',
        cluster: process.env.workerId,
        debug: false
    }),
    isWin = platform() === 'win32';

cpc.onMaster('decrypt', async (req: DecryptOptions, res) => {

    log.info(`Decrypting & extracting file... [${formatPath(req.input)}]`);

    let head: encryptHead,
        mkedDir = {};

    try {

        head = await checkHead(req.input);

        const privateKeyDecipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(req.passwordHash), head.encryptedPrivateKey.slice(-12)).setAuthTag(head.encryptedPrivateKey.slice(-28, -12)),
            privateKey = crypto.createPrivateKey({
                key: Buffer.concat([privateKeyDecipher.update(head.encryptedPrivateKey.slice(0, -28)), privateKeyDecipher.final()]),
                format: 'pem',
                passphrase: req.passwordHash
            }),
            key = crypto.privateDecrypt(privateKey, head.encryptedKey),
            input = PATH.parse(req.input),
            output = PATH.join(input.dir, input.name),
            extract = new archive.Extract();

        extract.onEntry((header, stream, next) => {

            if (header.type === 'file')
                if (head.isFile)
                    stream
                        .pipe(crypto.createDecipheriv('aes-256-ctr', key, hashMD5(header.name)))
                        .pipe(fs.createWriteStream(output, { mode: 0o644 })).on('finish', next)

                else {
                    const index = header.name.lastIndexOf('/');
                    mkdir(header.name.slice(0, index === -1 ? 0 : index), (err) => {
                        if (err) return next(err);
                        stream
                            .pipe(crypto.createDecipheriv('aes-256-ctr', key, hashMD5(header.name)))
                            .pipe(fs.createWriteStream(PATH.join(output, header.name), { mode: 0o644 })).on('finish', next)
                    });
                }
            else (function dirHandler() {
                let pending = true,
                    streamDropped = false;

                stream.skip(() => {
                    if (!pending) return next();
                    streamDropped = true;
                });

                mkdir(header.name, (err) => {
                    if (err) return next(err);
                    if (streamDropped) return next()
                    pending = false
                });
            })();


            function mkdir(dirname: string, cb: (err?: NodeJS.ErrnoException) => void) {
                if (mkedDir[dirname]) return cb();
                fs.mkdir(PATH.join(output, dirname), { recursive: true, mode: 0o755 }, (err) => {
                    if (err) return cb(err);
                    const arr = dirname.split('/');
                    let p = ''
                    for (let i = 0, l = arr.length; i < l; i++) {
                        p += '/' + arr[i]
                        mkedDir[p] = true;
                    }
                    cb();
                });
            }
        })

        fs.createReadStream(req.input, { start: 3867 })
            .pipe(extract.input).on('finish', res);

    } catch (err) {
        log.debug(err);
        res(err);
    }

    function checkHead(path: string) {
        return new Promise<encryptHead>(async (resolve, reject) => {
            fs.open(path, 'r', (err, fd) => {
                if (err) return reject(err);
                fs.read(fd, Buffer.alloc(3867), 0, 3867, 0, (err, bytesLength, buffer) => {
                    if (err) return reject(err);
                    const fileType = buffer.slice(0, 1).toString('utf8');
                    let isFile = null;
                    if (fileType === 'F') isFile = true;
                    else if (fileType === 'D') isFile = false;
                    else return reject('Unknown type');

                    fs.close(fd, (err) => {
                        if (err) return reject(err);
                        resolve({
                            encryptedPrivateKey: buffer.slice(1, 3355),
                            encryptedKey: buffer.slice(3355),
                            isFile: isFile
                        });
                    });
                });
            });
        });
    }


}).onMaster('backup', async (req: BackupOptions, res) => {

    let bytesLength = 0,
        key: Buffer,
        head: encryptHead,
        previousBackupPath: string,
        mods = {
            file: [0, 0],
            directory: [0, 0]
        };

    const inputStats = await new Promise<fs.Stats>((resolve) =>
        fs.stat(req.input, (err, stats) => {
            if (err) return res(err);
            resolve(stats);
        })),
        isFile = inputStats.isFile(),
        l = req.output.length,
        fileName = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 255) + '.backup',
        outputs = req.output.map(p => { return fs.createWriteStream(PATH.join(p, fileName + '.temp')); }),
        writeStream = new Writable({
            write(chunk, encoding, next) {
                bytesLength += chunk.length;
                for (let i = l; i--;) outputs[i].write(chunk);
                next();
            }
        }).on('finish', () => Promise.all(outputs.map((output, i) => {
            return new Promise<void>((resolve, reject) =>
                output.end(() =>
                    fs.rename(PATH.join(req.output[i], fileName + '.temp'), PATH.join(req.output[i], fileName), (err) => {
                        if (err) return reject(err)
                        resolve();
                    })
                )
            )
        })).then(() => res(null, bytesLength, mods)).catch(res)),
        pack = new archive.Pack();

    log.info(`Syncing & encrypting ${isFile ? 'file' : 'folder'}... [${formatPath(req.input)}]`);

    try {

        if (isFile) {

            for (let i = 0; i < l; i++)  try {
                const path = PATH.join(req.output[i], fileName);
                head = await checkHead(path);
                previousBackupPath = path;
            } catch (err) { }

            if (head) {

                log.info(`Previous backup found, comparing modified time... [${formatPath(req.input)}]`);

                const extract = new archive.Extract();

                key = crypto.randomBytes(32);

                extract.onEntry((header, stream, next) => {

                    const mtime = Math.floor(inputStats.mtimeMs);

                    if (mtime > header.mtime) fileHandler(), mods.file[0]++;
                    else stream.pipe(pack.entry(header, next));

                    function fileHandler() {
                        let pending = true,
                            streamDropped = false;

                        const randomName = crypto.randomBytes(64).toString();

                        stream.skip(() => {
                            if (!pending) return next();
                            streamDropped = true;
                        })

                        fs.createReadStream(req.input)
                            .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(randomName)))
                            .pipe(pack.entry({
                                name: randomName,
                                size: inputStats.size,
                                mtime: mtime,
                                type: 'file'
                            }, () => {
                                if (streamDropped) return next()
                                pending = false
                            }));
                    }
                })

                writeStream.write(Buffer.concat([
                    Buffer.from('F'),
                    Buffer.from(req.encryptedPrivateKey, 'hex'),
                    crypto.publicEncrypt(req.publicKey, key)
                ]), (err) => {
                    if (err) return res(err);

                    pack.output.pipe(writeStream);

                    fs.createReadStream(previousBackupPath, { start: 3867 })
                        .pipe(extract.input).on('finish', () => pack.finalize());
                });

            } else {

                log.info(`Previous backup not found, making new one... [${formatPath(req.input)}]`);

                key = crypto.randomBytes(32);
                const randomName = crypto.randomBytes(64).toString();

                writeStream.write(Buffer.concat([
                    Buffer.from('F'),
                    Buffer.from(req.encryptedPrivateKey, 'hex'),
                    crypto.publicEncrypt(req.publicKey, key)
                ]), (err) => {
                    if (err) return res(err);

                    fs.createReadStream(req.input)
                        .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(randomName)))
                        .pipe(pack.entry({
                            name: randomName,
                            size: inputStats.size,
                            mtime: Math.floor(inputStats.mtimeMs),
                            type: 'file'
                        }, (err) => {
                            if (err) return res(err);
                            pack.finalize();
                        }));

                    mods.file[0]++;

                    pack.output.pipe(writeStream);
                });
            }

        } else {

            for (let i = 0; i < l; i++)  try {
                const path = PATH.join(req.output[i], fileName);
                head = await checkHead(path);
                previousBackupPath = path;
                if (head.encryptedPrivateKey.toString('hex') !== req.encryptedPrivateKey)
                    log.warn(`Private key is different from previous backup [${formatPath(path)}]`), head = null;
                else break;
            } catch (err) { }

            const regs = req.ignore.map(str => {
                return regex.from(str)
            }), prefixLength = req.input.length;

            if (head) {

                log.info(`Previous backup found, comparing modifications... [${formatPath(req.input)}]`);

                const passwordHash = await keytar.getPassword('safe-backup', req.account),
                    privateKeyDecipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(passwordHash), head.encryptedPrivateKey.slice(-12)).setAuthTag(head.encryptedPrivateKey.slice(-28, -12)),
                    privateKey = crypto.createPrivateKey({
                        key: Buffer.concat([privateKeyDecipher.update(head.encryptedPrivateKey.slice(0, -28)), privateKeyDecipher.final()]),
                        format: 'pem',
                        passphrase: passwordHash
                    }),
                    extract = new archive.Extract();

                key = crypto.privateDecrypt(privateKey, head.encryptedKey);

                let entries: { [name: string]: Header } = {};

                extract.onEntry((header, stream, next) => {
                    let path = PATH.join(req.input, header.name);

                    getHeader(path, (err, stats) => {

                        if (err)
                            if (err.code === 'ENOENT')
                                return stream.skip(next), mods[header.type][1]++;
                            else return next(err);
                        else if (!stats) return stream.skip(next), mods[header.type][1]++;

                        const n = stats.name.split('/');

                        for (let i = regs.length; i--;)
                            if (regs[i].test(stats.name) || n.indexOfRegex(regs[i]) > -1)
                                return entries[header.type === 'directory' ? path.slice(0, -1) : path] = {
                                    name: null,
                                    size: null,
                                    type: 'file',
                                    mtime: null
                                }, stream.skip(next);


                        if (header.type !== stats.type) {
                            switch (stats.type) {
                                case 'file':
                                    fileHandler();
                                    mods.directory[1]++;
                                    mods.file[0]++;
                                    break;
                                case 'directory':
                                    pack.writeHeader(stats);
                                    stream.skip(next)
                                    mods.directory[0]++;
                                    mods.file[1]++;
                                    break;
                            }
                        } else if (stats.mtime > header.mtime) {
                            switch (stats.type) {
                                case 'file':
                                    fileHandler();
                                    mods.file[0]++;
                                    break;
                                case 'directory':
                                    pack.writeHeader(stats);
                                    stream.skip(next)
                                    mods.directory[0]++;
                                    break;
                            }
                        } else stream.pipe(pack.entry(header, next));

                        entries[header.type === 'directory' ? path.slice(0, -1) : path] = stats;

                        function fileHandler() {
                            let pending = true,
                                streamDropped = false;

                            stream.skip(() => {
                                if (!pending) return next();
                                streamDropped = true;
                            });

                            fs.createReadStream(path)
                                .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(stats.name)))
                                .pipe(pack.entry(stats, () => {
                                    if (streamDropped) return next()
                                    pending = false
                                }));
                        }

                    });
                });

                writeStream.write(Buffer.concat([
                    Buffer.from('D'),
                    head.encryptedPrivateKey,
                    head.encryptedKey
                ]), (err) => {
                    if (err) return res(err);

                    pack.output.pipe(writeStream);

                    fs.createReadStream(previousBackupPath, { start: 3867 })
                        .pipe(extract.input).on('finish', () =>
                            updateHeader(req.input, (err) => {
                                if (err) return res(err);
                                pack.finalize();
                            })
                        );
                });

                function updateHeader(path: string, cb: (err: NodeJS.ErrnoException) => void) {

                    if (entries[path])
                        if (entries[path].type === 'directory')
                            recursiveDir();
                        else cb(null);
                    else getHeader(path, (err, stats) => {
                        if (err) return cb(err);

                        const n = stats.name.split('/');

                        for (let i = regs.length; i--;)
                            if (regs[i].test(stats.name) || n.indexOfRegex(regs[i]) > -1)
                                return cb(null);

                        if (stats.type === 'directory') {
                            pack.writeHeader(stats);
                            recursiveDir();
                            mods.directory[0]++;
                        } else fs.createReadStream(path)
                            .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(stats.name)))
                            .pipe(pack.entry(stats, cb)), mods.file[0]++;;

                    });

                    function recursiveDir() {
                        fs.readdir(path, (err, files) => {
                            if (err) return cb(err);

                            const l = files.length;

                            (function next(i = 0) {
                                if (i === l) return cb(null);
                                updateHeader(PATH.join(path, files[i]), (err) => {
                                    if (err) return cb(err);
                                    next(i + 1)
                                })
                            })();
                        });
                    }
                }

                function getHeader(path: string, cb: (err: NodeJS.ErrnoException, stats?: Header) => void) {

                    const name = normalizePath(path.slice(prefixLength));

                    fs.stat(path, (err, stats) => {
                        if (err) return cb(err);

                        if (stats.isDirectory()) {
                            cb(null, {
                                name: name + '/',
                                size: 0,
                                mtime: Math.floor(stats.mtimeMs),
                                type: 'directory'
                            })
                        } else if (stats.isFile())
                            cb(null, {
                                name: name,
                                size: stats.size,
                                mtime: Math.floor(stats.mtimeMs),
                                type: 'file'
                            });
                        else cb(null, null)
                    });
                }

            } else {

                log.info(`Previous backup not found, making new one... [${formatPath(req.input)}]`);

                key = crypto.randomBytes(32);

                writeStream.write(Buffer.concat([
                    Buffer.from('D'),
                    Buffer.from(req.encryptedPrivateKey, 'hex'),
                    crypto.publicEncrypt(req.publicKey, key)
                ]), (err) => {
                    if (err) return res(err);

                    pack.output.pipe(writeStream);

                    getEntry(req.input, (err) => {
                        if (err) return res(err);
                        pack.finalize();
                    });


                    function getEntry(path: string, cb: (err: NodeJS.ErrnoException) => void) {

                        const name = normalizePath(path.slice(prefixLength)),
                            n = name.split('/');

                        for (let i = regs.length; i--;)
                            if (regs[i].test(name) || n.indexOfRegex(regs[i]) > -1) return cb(null);

                        fs.stat(path, (err, stats) => {
                            if (err) return cb(err);

                            if (stats.isDirectory()) {
                                pack.writeHeader({
                                    name: name + '/',
                                    size: 0,
                                    mtime: Math.floor(stats.mtimeMs),
                                    type: 'directory'
                                });
                                fs.readdir(path, (err, files) => {
                                    if (err) return cb(err);

                                    const l = files.length;

                                    (function next(i = 0) {
                                        if (i === l) return cb(null);
                                        getEntry(PATH.join(path, files[i]), (err) => {
                                            if (err) return cb(err);
                                            next(i + 1)
                                        })
                                    })();
                                });

                                mods.directory[0]++;
                            }
                            else if (stats.isFile())
                                fs.createReadStream(path)
                                    .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(name)))
                                    .pipe(pack.entry({
                                        name: name,
                                        size: stats.size,
                                        mtime: Math.floor(stats.mtimeMs),
                                        type: 'file'
                                    }, cb)), mods.file[0]++;
                            else cb(null)
                        });
                    }
                });
            }
        }

    } catch (err) {
        log.debug(err);
        res(err);
    }

    function checkHead(path: string) {
        return new Promise<encryptHead>(async (resolve, reject) => {
            fs.open(path, 'r', (err, fd) => {
                if (err) return reject(err);
                fs.read(fd, Buffer.alloc(3867), 0, 3867, 0, (err, bytesLength, buffer) => {
                    if (err) return reject(err);
                    const fileType = buffer.slice(0, 1).toString('utf8');
                    if (isFile && fileType !== 'F') return reject(`Expecting file`);
                    else if (!isFile && fileType !== 'D') return reject(`Expecting directory`);

                    fs.close(fd, (err) => {
                        if (err) return reject(err);
                        resolve({
                            encryptedPrivateKey: buffer.slice(1, 3355),
                            encryptedKey: buffer.slice(3355)
                        });
                    });
                });
            });
        });
    }
});

function hashPassword(p: string, salt = '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8') {
    return crypto.createHash('sha256').update(p + salt).digest();
}

function hashMD5(s: string) {
    return crypto.createHash('md5').update('67ea949a58f394d357de7f9b6b003403' + s + '1dfdffe2268ccf653daca275d4294de5').digest();
}

function formatPath(p: string, max: number = 30) {
    const l = p.length
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(- Math.floor(n));
    }
    return p;
}

function normalizePath(p: string) {
    return isWin ? p.replace(/\\/g, '/').replace(/^\/|\/$/g, '') : p.replace(/^\/|\/$/g, '');
}