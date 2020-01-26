"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const regex = require("simple-regex-toolkit");
const appdata_path_1 = require("appdata-path");
const worker_communication_1 = require("worker-communication");
const colorful_log_1 = require("colorful-log");
const stream_1 = require("stream");
const crypto = require("crypto");
const os_1 = require("os");
const PATH = require("path");
const bua = require("bua");
const fs = require("fs");
process.on('SIGINT', () => { });
const appDataPath = appdata_path_1.default('safe-backup'), cpc = new worker_communication_1.default(), log = new colorful_log_1.default({
    system: 'worker',
    cluster: parseInt(process.env.workerId),
    path: PATH.join(appDataPath, 'logs'),
    debug: false
}), isWin = os_1.platform() === 'win32';
cpc.onMaster('saveLog', async (req, res) => {
    log.save().then(res).catch(res);
}).onMaster('decrypt', async (req, res) => {
    log.info(`Decrypting & extracting file... [${formatPath(req.input)}]`);
    let head, mkedDir = {};
    try {
        head = await checkHead(req.input);
        const privateKeyDecipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(req.passwordHash), head.encryptedPrivateKey.slice(-12)).setAuthTag(head.encryptedPrivateKey.slice(-28, -12)), privateKey = crypto.createPrivateKey({
            key: Buffer.concat([privateKeyDecipher.update(head.encryptedPrivateKey.slice(0, -28)), privateKeyDecipher.final()]),
            format: 'pem',
            passphrase: req.passwordHash
        }), key = crypto.privateDecrypt(privateKey, head.encryptedKey), input = PATH.parse(req.input), output = PATH.join(input.dir, input.name), extract = new bua.Extract();
        extract.entry((header, stream, next) => {
            if (header.type === 'file')
                if (head.isFile)
                    stream
                        .pipe(crypto.createDecipheriv('aes-256-ctr', key, hashMD5(header.name)))
                        .pipe(fs.createWriteStream(output, { mode: header.mode || 0o644 })).on('finish', () => utimes(output, (err) => {
                        if (err)
                            return next(err);
                        next();
                    }));
                else {
                    const index = header.name.lastIndexOf('/'), path = PATH.join(output, header.name), dirName = header.name.slice(0, index === -1 ? 0 : index), dirPath = PATH.join(output, dirName);
                    mkdir(dirPath, dirName, (err) => {
                        if (err)
                            return next(err);
                        stream
                            .pipe(crypto.createDecipheriv('aes-256-ctr', key, hashMD5(header.name)))
                            .pipe(fs.createWriteStream(path, { mode: header.mode || 0o644 })).on('close', () => utimes(path, (err) => {
                            if (err)
                                return next(err);
                            next();
                        }));
                    });
                }
            else
                (function dirHandler() {
                    let pending = true, streamDropped = false;
                    stream.skip(() => {
                        if (!pending)
                            return next();
                        streamDropped = true;
                    });
                    const path = PATH.join(output, header.name);
                    mkdir(path, header.name, (err) => {
                        if (err)
                            return next(err);
                        utimes(path, (err) => {
                            if (err)
                                return next(err);
                            if (streamDropped)
                                return next();
                            pending = false;
                        });
                    });
                })();
            function mkdir(path, dirName, cb) {
                if (mkedDir[dirName])
                    return cb();
                fs.mkdir(path, { recursive: true, mode: header.type === 'directory' ? (header.mode || 0o755) : 0o755 }, (err) => {
                    if (err)
                        return cb(err);
                    const arr = dirName.split('/');
                    let p = '';
                    for (let i = 0, l = arr.length; i < l; i++) {
                        p += '/' + arr[i];
                        mkedDir[p] = true;
                    }
                    cb();
                });
            }
            function utimes(path, cb) {
                fs.utimes(path, new Date(), new Date(header.mtime), (err) => {
                    if (err)
                        return cb(err);
                    cb();
                });
            }
        });
        fs.createReadStream(req.input, { start: 3867 })
            .pipe(extract.input)
            .on('finish', res)
            .on('error', (err) => {
            log.debug(err);
            res(err);
        });
    }
    catch (err) {
        log.debug(err);
        res(err);
    }
    function checkHead(path) {
        return new Promise(async (resolve, reject) => {
            fs.open(path, 'r', (err, fd) => {
                if (err)
                    return reject(err);
                fs.read(fd, Buffer.alloc(3867), 0, 3867, 0, (err, bytesLength, buffer) => {
                    if (err)
                        return reject(err);
                    const fileType = buffer.slice(0, 1).toString('utf8');
                    let isFile = null;
                    if (fileType === 'F')
                        isFile = true;
                    else if (fileType === 'D')
                        isFile = false;
                    else
                        return reject('Unknown type');
                    fs.close(fd, (err) => {
                        if (err)
                            return reject(err);
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
}).onMaster('backup', async (req, res) => {
    let bytesLength = 0, key, head, previousBackupPath, mods = {
        file: [0, 0],
        directory: [0, 0]
    };
    const inputStats = await new Promise((resolve) => fs.stat(req.input, (err, stats) => {
        if (err)
            return res(err);
        resolve(stats);
    })), isFile = inputStats.isFile(), l = req.output.length, fileName = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 240) + '.backup', outputs = req.output.map(p => { return fs.createWriteStream(PATH.join(p, fileName + '.temp')); }), writeStream = new stream_1.Writable({
        write(chunk, encoding, next) {
            bytesLength += chunk.length;
            for (let i = l; i--;)
                outputs[i].write(chunk);
            next();
        }
    }).on('finish', () => Promise.all(outputs.map((output, i) => {
        return new Promise((resolve, reject) => output.end(() => fs.rename(PATH.join(req.output[i], fileName + '.temp'), PATH.join(req.output[i], fileName), (err) => {
            if (err)
                return reject(err);
            resolve();
        })));
    })).then(() => res(null, bytesLength, mods)).catch(res)), pack = new bua.Pack();
    log.info(`Syncing & encrypting ${isFile ? 'file' : 'folder'}... [${formatPath(req.input)}]`);
    try {
        if (isFile) {
            for (let i = 0; i < l; i++)
                try {
                    const path = PATH.join(req.output[i], fileName);
                    head = await checkHead(path);
                    previousBackupPath = path;
                }
                catch (err) { }
            if (head) {
                log.info(`Previous backup found, comparing modified time... [${formatPath(req.input)}]`);
                const extract = new bua.Extract();
                key = crypto.randomBytes(32);
                extract.entry((header, stream, next) => {
                    const mtime = Math.floor(inputStats.mtimeMs);
                    if (mtime > header.mtime)
                        fileHandler(), mods.file[0]++;
                    else
                        stream.pipe(pack.entry(header, next));
                    function fileHandler() {
                        let pending = true, streamDropped = false;
                        const randomName = crypto.randomBytes(64).toString();
                        stream.skip(() => {
                            if (!pending)
                                return next();
                            streamDropped = true;
                        });
                        fs.createReadStream(req.input)
                            .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(randomName)))
                            .pipe(pack.entry({
                            name: randomName,
                            size: inputStats.size,
                            mtime: mtime,
                            mode: inputStats.mode,
                            type: 'file'
                        }, () => {
                            if (streamDropped)
                                return next();
                            pending = false;
                        }));
                    }
                });
                writeStream.write(Buffer.concat([
                    Buffer.from('F'),
                    Buffer.from(req.encryptedPrivateKey, 'hex'),
                    crypto.publicEncrypt(req.publicKey, key)
                ]), (err) => {
                    if (err)
                        return res(err);
                    pack.output.pipe(writeStream);
                    fs.createReadStream(previousBackupPath, { start: 3867 })
                        .pipe(extract.input)
                        .on('finish', () => pack.finalize());
                });
            }
            else {
                log.info(`Previous backup not found, making new one... [${formatPath(req.input)}]`);
                key = crypto.randomBytes(32);
                const randomName = crypto.randomBytes(64).toString();
                writeStream.write(Buffer.concat([
                    Buffer.from('F'),
                    Buffer.from(req.encryptedPrivateKey, 'hex'),
                    crypto.publicEncrypt(req.publicKey, key)
                ]), (err) => {
                    if (err)
                        return res(err);
                    fs.createReadStream(req.input)
                        .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(randomName)))
                        .pipe(pack.entry({
                        name: randomName,
                        size: inputStats.size,
                        mtime: Math.floor(inputStats.mtimeMs),
                        mode: inputStats.mode,
                        type: 'file'
                    }, (err) => {
                        if (err)
                            return res(err);
                        pack.finalize();
                    }));
                    mods.file[0]++;
                    pack.output.pipe(writeStream);
                });
            }
        }
        else {
            for (let i = 0; i < l; i++)
                try {
                    const path = PATH.join(req.output[i], fileName);
                    head = await checkHead(path);
                    previousBackupPath = path;
                    if (head.encryptedPrivateKey.toString('hex') !== req.encryptedPrivateKey)
                        log.warn(`Private key is different from previous backup, re-encrypting... [${formatPath(path)}]`), head = null;
                    else
                        break;
                }
                catch (err) { }
            if (head && !req.passwordHash)
                log.warn(`Previous backup found but save password function is disabled, re-encrypting... [${formatPath(req.input)}]`), head = null;
            const regs = req.ignore.map(str => {
                return regex.from(str);
            }), prefixLength = req.input.length;
            if (head) {
                log.info(`Previous backup found, comparing modifications... [${formatPath(req.input)}]`);
                const privateKeyDecipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(req.passwordHash), head.encryptedPrivateKey.slice(-12)).setAuthTag(head.encryptedPrivateKey.slice(-28, -12)), privateKey = crypto.createPrivateKey({
                    key: Buffer.concat([privateKeyDecipher.update(head.encryptedPrivateKey.slice(0, -28)), privateKeyDecipher.final()]),
                    format: 'pem',
                    passphrase: req.passwordHash
                }), extract = new bua.Extract();
                key = crypto.privateDecrypt(privateKey, head.encryptedKey);
                let entries = {};
                extract.entry((header, stream, next) => {
                    let path = PATH.join(req.input, header.name);
                    getHeader(path, (err, stats) => {
                        if (err)
                            if (err.code === 'ENOENT')
                                return stream.skip(next), mods[header.type][1]++;
                            else
                                return next(err);
                        else if (!stats)
                            return stream.skip(next), mods[header.type][1]++;
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
                                    stream.skip(next);
                                    mods.directory[0]++;
                                    mods.file[1]++;
                                    break;
                            }
                        }
                        else if (stats.mtime > header.mtime) {
                            switch (stats.type) {
                                case 'file':
                                    fileHandler();
                                    mods.file[0]++;
                                    break;
                                case 'directory':
                                    pack.writeHeader(stats);
                                    stream.skip(next);
                                    mods.directory[0]++;
                                    break;
                            }
                        }
                        else
                            stream.pipe(pack.entry(header, next));
                        entries[header.type === 'directory' ? path.slice(0, -1) : path] = stats;
                        function fileHandler() {
                            let pending = true, streamDropped = false;
                            stream.skip(() => {
                                if (!pending)
                                    return next();
                                streamDropped = true;
                            });
                            fs.createReadStream(path)
                                .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(stats.name)))
                                .pipe(pack.entry(stats, () => {
                                if (streamDropped)
                                    return next();
                                pending = false;
                            }));
                        }
                    });
                });
                writeStream.write(Buffer.concat([
                    Buffer.from('D'),
                    head.encryptedPrivateKey,
                    head.encryptedKey
                ]), (err) => {
                    if (err)
                        return res(err);
                    pack.output.pipe(writeStream);
                    fs.createReadStream(previousBackupPath, { start: 3867 })
                        .pipe(extract.input).on('finish', () => updateHeader(req.input, (err) => {
                        if (err)
                            return res(err);
                        pack.finalize();
                    }));
                });
                function updateHeader(path, cb) {
                    if (entries[path])
                        if (entries[path].type === 'directory')
                            recursiveDir();
                        else
                            cb(null);
                    else
                        getHeader(path, (err, stats) => {
                            if (err)
                                return cb(err);
                            const n = stats.name.split('/');
                            for (let i = regs.length; i--;)
                                if (regs[i].test(stats.name) || n.indexOfRegex(regs[i]) > -1)
                                    return cb(null);
                            if (stats.type === 'directory') {
                                pack.writeHeader(stats);
                                recursiveDir();
                                mods.directory[0]++;
                            }
                            else
                                fs.createReadStream(path)
                                    .pipe(crypto.createCipheriv('aes-256-ctr', key, hashMD5(stats.name)))
                                    .pipe(pack.entry(stats, cb)), mods.file[0]++;
                            ;
                        });
                    function recursiveDir() {
                        fs.readdir(path, (err, files) => {
                            if (err)
                                return cb(err);
                            const l = files.length;
                            (function next(i = 0) {
                                if (i === l)
                                    return cb(null);
                                updateHeader(PATH.join(path, files[i]), (err) => {
                                    if (err)
                                        return cb(err);
                                    next(i + 1);
                                });
                            })();
                        });
                    }
                }
                function getHeader(path, cb) {
                    const name = normalizePath(path.slice(prefixLength));
                    fs.stat(path, (err, stats) => {
                        if (err)
                            return cb(err);
                        if (stats.isDirectory()) {
                            cb(null, {
                                name: name + '/',
                                size: 0,
                                mtime: Math.floor(stats.mtimeMs),
                                mode: stats.mode,
                                type: 'directory'
                            });
                        }
                        else if (stats.isFile())
                            cb(null, {
                                name: name,
                                size: stats.size,
                                mtime: Math.floor(stats.mtimeMs),
                                mode: stats.mode,
                                type: 'file'
                            });
                        else
                            cb(null, null);
                    });
                }
            }
            else {
                key = crypto.randomBytes(32);
                writeStream.write(Buffer.concat([
                    Buffer.from('D'),
                    Buffer.from(req.encryptedPrivateKey, 'hex'),
                    crypto.publicEncrypt(req.publicKey, key)
                ]), (err) => {
                    if (err)
                        return res(err);
                    pack.output.pipe(writeStream);
                    getEntry(req.input, (err) => {
                        if (err)
                            return res(err);
                        pack.finalize();
                    });
                    function getEntry(path, cb) {
                        const name = normalizePath(path.slice(prefixLength)), n = name.split('/');
                        for (let i = regs.length; i--;)
                            if (regs[i].test(name) || n.indexOfRegex(regs[i]) > -1)
                                return cb(null);
                        fs.stat(path, (err, stats) => {
                            if (err)
                                return cb(err);
                            if (stats.isDirectory()) {
                                pack.writeHeader({
                                    name: name + '/',
                                    size: 0,
                                    mtime: Math.floor(stats.mtimeMs),
                                    mode: stats.mode,
                                    type: 'directory'
                                });
                                fs.readdir(path, (err, files) => {
                                    if (err)
                                        return cb(err);
                                    const l = files.length;
                                    (function next(i = 0) {
                                        if (i === l)
                                            return cb(null);
                                        getEntry(PATH.join(path, files[i]), (err) => {
                                            if (err)
                                                return cb(err);
                                            next(i + 1);
                                        });
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
                                    mode: stats.mode,
                                    type: 'file'
                                }, cb)), mods.file[0]++;
                            else
                                cb(null);
                        });
                    }
                });
            }
        }
    }
    catch (err) {
        log.debug(err);
        res(err);
    }
    function checkHead(path) {
        return new Promise(async (resolve, reject) => {
            fs.open(path, 'r', (err, fd) => {
                if (err)
                    return reject(err);
                fs.read(fd, Buffer.alloc(3867), 0, 3867, 0, (err, bytesLength, buffer) => {
                    if (err)
                        return reject(err);
                    const fileType = buffer.slice(0, 1).toString('utf8');
                    if (isFile && fileType !== 'F')
                        return reject(`Expecting file`);
                    else if (!isFile && fileType !== 'D')
                        return reject(`Expecting directory`);
                    fs.close(fd, (err) => {
                        if (err)
                            return reject(err);
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
function hashPassword(p, salt = '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8') {
    return crypto.createHash('sha256').update(p + salt).digest();
}
function hashMD5(s) {
    return crypto.createHash('md5').update('67ea949a58f394d357de7f9b6b003403' + s + '1dfdffe2268ccf653daca275d4294de5').digest();
}
function formatPath(p, max = 30) {
    const l = p.length;
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(-Math.floor(n));
    }
    return p;
}
function normalizePath(p) {
    return isWin ? p.replace(/\\/g, '/').replace(/^\/|\/$/g, '') : p.replace(/^\/|\/$/g, '');
}
