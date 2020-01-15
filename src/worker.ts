import CPC from 'worker-communication';
import { loggerClient } from 'cluster-ipc-logger';
import { Writable } from 'stream';
import * as fs from 'fs';
import * as PATH from 'path';
import * as tar from 'tar-fs';
import * as crypto from 'crypto';
import * as regex from 'simple-regex-toolkit';

__dirname = PATH.join(__dirname, '../');
process.on('SIGINT', () => { });

type Head = {
    iv: Buffer;
    isFile: boolean;
    encrypted: Buffer;
    authTag: Buffer;
    end: number;
}

const cpc = new CPC(),
    log = new loggerClient({
        system: 'worker',
        cluster: process.env.workerId
    });

cpc.onMaster('decrypt', (req: DecryptOptions, res) => {
    log.info(`Reading encrypted private key...`)

    fs.readFile(PATH.join(__dirname, 'keys', 'private.safe'), async (err, data) => {
        if (err) return res(err);

        log.info(`Decrypting private key... [${formatPath(PATH.join(__dirname, 'keys', 'private.safe'))}] `);

        try {

            const decipher = crypto.createDecipheriv('aes-256-gcm', hashPassword(req.passwordHash), data.slice(-12)).setAuthTag(data.slice(-28, -12)),
                encodedPrivateKey = Buffer.concat([decipher.update(data.slice(0, -28)), decipher.final()]);

            log.info(`Decoding private key with passphrase...`);

            const privateKey = crypto.createPrivateKey({
                key: encodedPrivateKey,
                format: 'pem',
                passphrase: req.passwordHash
            });

            log.info(`Decrypting password of the encryption...`);

            const head = await getHead(req.input),
                key = crypto.privateDecrypt(privateKey, head.encrypted);

            log.info(`Decrypting file... [${formatPath(req.input)}]`);

            const input = PATH.parse(req.input),
                output = PATH.join(input.dir, input.name),
                outputStream = head.isFile ? fs.createWriteStream(output) : tar.extract(output);

            outputStream.on('finish', res);
            fs.createReadStream(req.input, { start: 525, end: head.end - 1 })
                .pipe(crypto.createDecipheriv('aes-256-gcm', key, head.iv).setAuthTag(head.authTag))
                .pipe(outputStream)

        } catch (err) {
            res(err);
        }
    });

}).onMaster('backup', async (req: BackupOptions, res) => {

    log.info(`Syncing... [${formatPath(req.input)
        }]`)

    const l = req.output.length,
        name = formatPath(req.input.replace(/[\\*/!|:?<>]+/g, '-'), 255) + '.backup',
        isFile = await new Promise<boolean>((resolve: (isFile: boolean) => void) => {
            fs.stat(req.input, (err, stats) => {
                if (err) return res(err);
                resolve(stats.isFile());
            });
        });

    let writeStream: Writable,
        outputs: fs.WriteStream[] = [],
        bytes = 0;

    for (let i = l; i--;)
        outputs.push(fs.createWriteStream(PATH.join(req.output[i], name + '.temp')));

    const key = crypto.randomBytes(32),
        iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    writeStream = new Writable({
        write(chunk, encoding, next) {
            bytes += chunk.length;
            for (let i = l; i--;) outputs[i].write(chunk);
            next();
        }
    }).on('finish', () => {
        const authTag = cipher.getAuthTag();
        bytes += authTag.length;

        let promises = [];

        for (let i = l; i--;)
            promises.push(new Promise<void>((resolve, reject) =>
                outputs[i].end(authTag, () =>
                    fs.rename(PATH.join(req.output[i], name + '.temp'), PATH.join(req.output[i], name), (err) => {
                        if (err) return reject(err)
                        resolve()
                    })
                )
            ));

        Promise.all(promises).then(() => res(null, bytes)).catch(res);
    });

    writeStream.write(Buffer.concat([Buffer.from(isFile ? 'F' : 'D'), iv]), err => {
        if (err) return res(err);
        writeStream.write(crypto.publicEncrypt(req.publicKey, key), err => {
            if (err) return res(err);
            if (isFile) fs.createReadStream(req.input).on('error', res).pipe(cipher).pipe(writeStream);
            else tar.pack(req.input, {
                ignore: (file) => {
                    const arr = file.split(PATH.sep);
                    for (let i = req.ignore.length; i--;) {
                        const reg = regex.from(req.ignore[i]);
                        if (reg.test(file) || arr.indexOfRegex(reg) > -1)
                            return true;
                    }
                    return false;
                },
                //@ts-ignore, see: https://github.com/cloudron-io/tar-fs/commit/c941c1e364f5345686f92656238a1f8ce67232f3
                ignoreFileRemoved: (path: string, err: NodeJS.ErrnoException) => {
                    if (err.code === 'ENOENT') return true;
                    return false;
                }
            }).on('error', res).pipe(cipher).pipe(writeStream)
        });
    });

});

function getHead(path: string) {
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
}

function formatPath(p: string, max: number = 30) {
    const l = p.length
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(- Math.floor(n));
    }
    return p;
}

function hashPassword(p: string, salt = '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8') {
    return crypto.createHash('sha256').update(p + salt).digest();
}