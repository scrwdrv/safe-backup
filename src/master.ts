import { loggerServer, loggerClient } from 'cluster-ipc-logger';
import physicalCores from 'physical-cores';
import CPC from 'worker-communication';
import CLIParams from 'cli-params';
import Prompt from './prompt';
import * as regex from 'simple-regex-toolkit';
import * as cluster from 'cluster';
import * as crypto from 'crypto';
import * as dir from 'recurdir';
import * as PATH from 'path';
import * as fs from 'fs';

__dirname = PATH.join(__dirname, '../');
process.on('SIGINT', () => exit());

declare global {
    interface Config {
        input: string[];
        output: string[];
        watch: number;
        ignore: string[];
        publicKey: string;
    }

    interface BackupOptions {
        input: string;
        output: string[];
        publicKey: string;
        privateKey: string;
        ignore: string[];
    }

    interface DecryptOptions {
        input: string;
        passwordHash: string;
    }
}

const cpc = new CPC(),
    prompt = new Prompt(),
    logServer = new loggerServer({
        directory: PATH.join(__dirname, 'logs'),
        saveInterval: 60000
    }),
    log = new loggerClient({
        system: 'master',
        cluster: 0,
        debug: false
    }),
    helpText = `
Usage:
    safe-backup --input <inputPath1> [inputPath2 [inputPath3 ...]] 
                --output <outputPath1> [outputPath2 [outputPath3 ...]] 
                [--watch [interval]] [--ignore <regex> [regex [regex...]] 
    safe-backup --decrypt <backupPath> [--password <password>]
    safe-backup --help
    safe-backup --version
    safe-backup --config
    safe-backup --build-config
    safe-backup --reset-key

Options:
    -i --input          Absolute path(s) of folder/file to backup, separate by space.
    -o --output         Absolute path(s) of folder to store encrypted file, separate by space.
    -w --watch          Enable watch mode.
    -I --ignore         Add ignore rule with regex.  
    -d --decrypt        Absolute path of encrypted file to decrypt.
    -p --password       Password for decryption (not recommended to use password in command line).
    -h --help           Show this screen.
    -v --version        Show version.
    -c --config         Show current configuration.
    -b --build-config   Start building configurations.
    --reset-key         Delete both public & private key, 
                        previously encrypted files can still decrypt by original password.
    `;

let config: Config = {} as any,
    workers: cpcClusterWorker[] = [],
    running: number[] = [],
    modified: { [input: string]: number } = {},
    keys: {
        public: string;
        private: string;
    } = {
        public: null,
        private: null
    },
    exitState = 0;

(async function init() {

    try {

        await parseParams();
        await handleConfig(Object.keys(config).length ? config : null);
        await dir.mk(config.output);
        await getPassword();

        for (let i = physicalCores < 1 ? 1 : physicalCores; i--;)
            forkWorker((i + 1).toString());

        let promises = [];

        for (let i = config.input.length; i--;)
            promises.push(
                backup({ input: config.input[i], output: config.output, publicKey: keys.public, privateKey: keys.private, ignore: config.ignore || [] })
                    .then(() => {
                        if (config.watch) return fs.stat(config.input[i], (err, stats) => {
                            if (err) return log.debug(err),
                                log.error(`Error occurred while accessing [${formatPath(config.input[i])}]`);
                            backupDaemon(config.input[i]);
                            watchMod(config.input[i], stats.isFile());
                        });
                    })
            )

        await Promise.all(promises);

        if (config.watch) safetyGuard();
        else exit();

    } catch (err) {
        if (err) log.error(err)
        return exit();
    }

})();

function parseParams() {
    return new Promise<void>((resolve, reject) =>
        new CLIParams()
            .add({
                params: [
                    {
                        param: 'input',
                        type: 'array-of-string',
                        alias: 'i'
                    }, {
                        param: 'watch',
                        type: 'int',
                        optional: true,
                        default: 60,
                        alias: 'w'
                    },
                    {
                        param: 'output',
                        type: 'array-of-string',
                        alias: 'o'
                    },
                    {
                        param: 'ignore',
                        type: 'array-of-string',
                        optional: true,
                        alias: 'I'
                    }
                ],
                id: 'regular'
            })
            .add({
                params: [
                    {
                        param: 'decrypt',
                        type: 'string',
                        alias: 'd'
                    }, {
                        param: 'password',
                        type: 'string',
                        optional: true,
                        alias: 'p'
                    }
                ],
                id: 'decrypt'
            })
            .add({
                params: {
                    param: 'help',
                    type: 'boolean',
                    alias: 'h'
                },
                id: 'help'
            })
            .add({
                params: {
                    param: 'version',
                    type: 'boolean',
                    alias: 'v'
                },
                id: 'version'
            })
            .add({
                params: {
                    param: 'config',
                    type: 'boolean',
                    alias: 'c'
                },
                id: 'config'
            })
            .add({
                params: {
                    param: 'build-config',
                    type: 'boolean',
                    alias: 'b'
                },
                id: 'build-config'
            })
            .add({
                params: {
                    param: 'reset-key',
                    type: 'boolean'
                },
                id: 'reset-key'
            })
            .exec(async (err, args, id) => {
                if (err)
                    if (process.argv.length === 2) log.info('No parameters were found, restoring configurations...'), resolve();
                    else return log.error(err), console.log(helpText), reject();
                else switch (id) {
                    case 'regular':
                        config.input = args.input;
                        config.output = args.output;
                        config.watch = args.watch;
                        if (args.ignore) {
                            config.ignore = [];
                            for (let i = args.ignore.length; i--;) {
                                if (regex.isRegex(args.ignore[i]))
                                    config.ignore.push(args.ignore[i]);
                                else return log.error(`Invalid regex [${args.ignore[i]}]`), reject();
                            }
                        }
                        resolve();
                        break;
                    case 'decrypt':
                        if (!PATH.isAbsolute(args.decrypt)) return log.error(`Path must be absolute [${formatPath(args.decrypt)}]`), reject();
                        const passwordHash = hashPassword(args.password ? args.password : await prompt.questions.getPassword()).toString('hex')
                        const t = Date.now();
                        forkWorker('1').sendJob('decrypt', {
                            input: args.decrypt,
                            passwordHash: passwordHash
                        }, (err) => {
                            if (err) log.debug(err), log.error(`Error occurred while decrypting [${formatPath(args.decrypt)}]`);
                            else {
                                const decrypt = PATH.parse(args.decrypt);
                                log.info(`Decrypted, duration: ${formatSec(Date.now() - t)}s [${formatPath(args.decrypt)}]`);
                                log.info(`Your decrypted file/folder can be found at ${PATH.join(decrypt.dir, decrypt.name)}`);
                            }
                            reject();
                        });
                        break;
                    case 'help':
                        console.log(helpText);
                        reject();
                        break;
                    case 'version':
                        console.log(`safe-backup version ${JSON.parse(fs.readFileSync(PATH.join(__dirname, 'package.json'), 'utf8')).version}`);
                        reject();
                        break;
                    case 'config':
                        handleConfig().then(() => {
                            console.log(prettyJSON(config));
                            config = {} as any;
                            reject();
                        }).catch(err => {
                            console.log(`No configuration file is found`);
                            reject();
                        });
                        break;
                    case 'build-config':
                        await askQuestions().catch(reject);
                        resolve();
                        break;
                    case 'reset-key':
                        if (await prompt.questions.getYn(`Are you sure you wanna reset your key [Y/N]?`))
                            fs.unlink(PATH.join(__dirname, 'key.safe'), (err) => {
                                if (err.code === 'ENOENT') console.log('There is no key');
                                else if (err) log.debug(err), console.log('Failed to delete key.safe');
                                else console.log('key deleted');
                                reject();
                            });
                        else reject();
                        break;
                }
            })
    )
}

function askQuestions() {
    return new Promise<void>(async (resolve, reject) => {
        log.info(`Start building configurations...`);
        try {
            config.input = await prompt.questions.getInput();
            config.output = await prompt.questions.getOutput();
            config.watch = await prompt.questions.getWatch();
            await handleConfig(config);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

function handleConfig(c?: Config) {
    return new Promise<void>((resolve, reject) => {
        if (c) fs.writeFile(PATH.join(__dirname, 'config.json'), JSON.stringify(c, null, 4), (err) => {
            if (err) return reject(err);
            checkPath();
        })
        else fs.readFile(PATH.join(__dirname, 'config.json'), 'utf8', async (err, data) => {
            if (c === undefined) {
                if (err) return reject(err);
                else config = JSON.parse(data);
                resolve();
            } else {
                if (err) await askQuestions().catch(reject);
                else config = JSON.parse(data);
                checkPath();
            }
        });

        function checkPath() {
            for (let typeOfPath of ['input', 'output'])
                for (let i = config[typeOfPath].length; i--;)
                    if (!PATH.isAbsolute(config[typeOfPath][i]))
                        return log.error(`Path must be absolute [${formatPath(config[typeOfPath][i])}]`), reject();
            resolve();
        }
    });
}

function getPassword() {
    return new Promise<void>(async (resolve, reject) => {
        fs.readFile(PATH.join(__dirname, 'key.safe'), 'utf8', (err, data) => {
            if (err) return log.warn(`Key pair not found, let's make one!`), setPassword();
            keys = JSON.parse(data);
            if (!keys.public || !keys.private) return reject(`Invalid key file`)
            resolve();
        });
        async function setPassword() {

            const hash = hashPassword(await prompt.questions.setPassword()).toString('hex');

            log.info(`Generating new RSA-4096 key pair...`);

            crypto.generateKeyPair('rsa', {
                modulusLength: 4096,
                publicKeyEncoding: {
                    type: 'pkcs1',
                    format: 'pem'
                },
                privateKeyEncoding: {
                    type: 'pkcs1',
                    format: 'pem',
                    cipher: 'aes-256-cbc',
                    passphrase: hash
                }
            }, (err, publicKey, privateKey) => {
                if (err) return reject(err);

                const iv = crypto.randomBytes(12),
                    cipher = crypto.createCipheriv('aes-256-gcm', hashPassword(hash, '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8'), iv);

                privateKey = Buffer.concat([cipher.update(privateKey), cipher.final(), cipher.getAuthTag(), iv]).toString('hex');

                keys.public = publicKey;
                keys.private = privateKey;

                fs.writeFile(PATH.join(__dirname, 'key.safe'), JSON.stringify(keys), (err) => {
                    if (err) return reject(err);
                    log.info(`Public & private key generated at ${PATH.join(__dirname, 'key.safe')}`);
                    resolve();
                });
            });
        }
    });
}

function forkWorker(id: string) {
    log.info(`Forking worker[${id}]`);
    const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));

    worker.on('exit', () => {
        worker.removeAllListeners('message');
        const index = workers.indexOf(worker);
        if (index > -1) workers.splice(index, 1);
        log.error(`Worker[${id}] died, forking new one...`);
        forkWorker(id);
    });
    workers.push(worker);
    return worker;
}

function backup(options: BackupOptions, mod?: number) {
    return new Promise<void>((resolve) => {
        const worker = getWokrer(),
            t = Date.now();

        running.push(worker.id);
        worker.sendJob('backup', options, (err, bytes) => {
            if (err) log.debug(err), log.error(`Error occurred while syncing [${formatPath(options.input)}]`);
            else if (mod) log.info(`Synced ${mod} mod${mod > 1 ? 's' : ''}, duration: ${formatSec(Date.now() - t)}s [${formatBytes(bytes)}][${formatPath(options.input)}]`);
            else log.info(`Synced, duration: ${formatSec(Date.now() - t)}s [${formatBytes(bytes)}][${formatPath(options.input)}]`)

            const index = running.indexOf(worker.id);
            if (index > -1) running.splice(index, 1);
            resolve();
        });
    });

    function getWokrer() {
        const worker = workers.shift();
        workers.push(worker);
        return worker;
    }
}

function backupDaemon(input: string) {
    if (exitState > 0) return;
    if (modified[input]) {
        backup({
            input: input,
            output: config.output,
            publicKey: keys.public,
            privateKey: keys.private,
            ignore: config.ignore || []
        }, modified[input]).then(() =>
            setTimeout(backupDaemon, config.watch * 1000, input));
        delete modified[input];
    } else setTimeout(backupDaemon, config.watch * 1000, input);
}


function watchMod(path: string, isFile: boolean, retry = 0) {
    if (retry > 5) {
        log.warn(`Stopped monitoring [${formatPath(path)}], next check in 10 mins...`);
        return setTimeout(watchMod, 600000, path, isFile, 0);
    }

    const watcher = fs.watch(path, { recursive: !isFile }, (evt, file) => {
        if (config.ignore) {
            const arr = file.split(PATH.sep);
            for (let i = config.ignore.length; i--;) {
                const reg = regex.from(config.ignore[i]);
                if (reg.test(file) || arr.indexOfRegex(reg) > -1) return;
            }
        }

        modified[path] ? modified[path]++ : modified[path] = 1;
        log.info(`File modified [${evt.toUpperCase()}][${formatPath(PATH.join(path, file))}]`);
    }).on('error', (err) => {
        log.debug(err);
        log.error(`Error occurred while monitoring [${formatPath(path)}], retry in 10 secs...`);
        watcher.removeAllListeners('close');
        watcher.close();
        clearTimeout(timeout);
        setTimeout(watchMod, 10000, path, isFile, retry + 1);
    }).on('close', () => {
        clearTimeout(timeout);
        setTimeout(watchMod, 10000, path, isFile, retry + 1);
    }), timeout = setTimeout(() => {
        retry = 0;
    }, 60000);
}

function safetyGuard() {
    let exited = false,
        errorsCount = 0;

    logServer.on('error', () => {
        if (exited) return;
        errorsCount++;
        if (errorsCount > config.input.length * 10) {
            log.error(`Too many errors occurred, something might went wrong, exiting...`)
            exited = true;
            exit();
        }
    });

    setInterval(() => {
        errorsCount = 0;
    }, 60000);
}

async function exit(retry: number = 0) {
    if (exitState === 2 || retry > 3) return process.exit();
    exitState = 1;

    const l = running.length;

    if (l) {
        exitState = 2;
        log.warn(`${l} task${l > 1 ? 's' : ''} still running, hang on...`);
        log.warn(`Ctrl+C again to force exit [NOT RECOMMENDED]`);
        await new Promise<void>(resolve => {
            const interval = setInterval(() => {
                if (!running.length) clearInterval(interval), resolve();
            }, 250)
        });
    }

    for (let i = workers.length; i--;)
        workers.pop()
            .removeAllListeners('exit')
            .kill();

    exitState = 2;
    logServer.save().then(process.exit).catch(() => exit(retry + 1));
}

function formatSec(ms: number) {
    return (ms / 1000).toFixed(2);
}

function formatPath(p: string, max: number = 30) {
    const l = p.length
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(- Math.floor(n));
    }
    return p;
}

function hashPassword(p: string, salt = '2ec8df9c3da9a2fe0b395cbc11c2dd54bc6a8dfec5ba2b7a96562aed17caffa9') {
    return crypto.createHash('sha256').update(p + salt).digest();
}

function prettyJSON(obj: { [key: string]: any }) {
    const json = JSON.stringify(obj, null, 4);
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
            let cls = '\x1b[35m\x1b[1m';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = '\x1b[36m\x1b[1m';
                } else {
                    cls = '\x1b[37m\x1b[1m';
                }
            }
            return cls + match + '\x1b[0m';
        }
    );
}

function formatBytes(bytes: number) {
    const chars = 'KMGTP',
        e = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, e)).toFixed(2) + ' ' + chars.charAt(e - 1) + 'B';
}