import updateCheck from 'startup-update-check';
import * as regex from 'simple-regex-toolkit';
import physicalCores from 'physical-cores';
import getAppDataPath from 'appdata-path';
import CPC from 'worker-communication';
import * as cluster from 'cluster';
import CLIParams from 'cli-params';
import Logger from 'colorful-log';
import * as crypto from 'crypto';
import * as semver from 'semver';
import * as dir from 'recurdir';
import watch from 'node-watch';
import Prompt from './prompt';
import * as PATH from 'path';
import color from 'addcolor';
import * as fs from 'fs';

process.on('SIGINT', () => exit());

declare global {

    interface Config {
        input: string[];
        output: string[];
        watch: number;
        ignore: string[];
        publicKey: string;
        savePassword: boolean;
    }

    interface BackupOptions {
        input: string;
        output: string[];
        passwordHash?: string;
        publicKey: string;
        encryptedPrivateKey: string;
        ignore: string[];
    }

    interface DecryptOptions {
        input: string;
        passwordHash: string;
    }

    interface Keys {
        public: string;
        encryptedPrivate: string;
        passwordHash?: string
    }

}

const appDataPath = getAppDataPath('safe-backup'),
    cpc = new CPC(),
    prompt = new Prompt(),
    log = new Logger({
        system: 'master',
        cluster: 0,
        path: PATH.join(appDataPath, 'logs'),
        debug: false
    }),
    helpText = `
Usage:

    safe-backup --input <inputPath1> [inputPath2 [inputPath3 ...]] 
                --output <outputPath1> [outputPath2 [outputPath3 ...]] 
                [--watch [interval]] [--ignore <regex> [regex [regex...]] 
                [--save-password [true|false]]

    safe-backup --decrypt <backupPath> [backupPath2 [backupPath3 ...]] [--password <password>]

    safe-backup --help
    safe-backup --version
    safe-backup --config
    safe-backup --build-config
    safe-backup --reset-config
    safe-backup --reset-key
    safe-backup --log
    safe-backup --export-config [path]
    safe-backup --import-config <path>
    safe-backup --export-key [path]
    safe-backup --import-key <path>

Options:

    -i --input          Absolute paths of folders/files to backup, separate by space,
                        paths start with \`*\` will not be encrypted or packed.
    -o --output         Absolute paths of folders to store backup files, separate by space.
    -w --watch          Enable watch mode.
    -I --ignore         Add ignore rules with regex, separate by space.  
    -s --save-password  Save password to the system. When backing up folders, previous password will be reused
                        so unchanged files don't need to be re-encrypt (a lot more faster).
                        This parameter set to true by default.

    -d --decrypt        Paths of encrypted files to decrypt.
    -p --password       Password for decryption (not recommended to use password in command line).

    -h --help           Show this screen.
    -v --version        Show version.
    -c --config         Show current configuration.
    -b --build-config   Start building configuration.
    --reset-config      Delete configuration file.
    --reset-key         Delete both public & private key, 
                        previously encrypted files can still decrypt by original password.
    -l --log            Show location of log files.
    --export-config     Export current configuration.
    --import-config     Import previously generated configuration.
    --export-key        Export current key.
    --import-key        Import previously generated key.
    `;

let config: Config = {} as any,
    workers: cpcClusterWorker[] = [],
    running: number[] = [],
    modified: { [input: string]: boolean } = {},
    keys: Keys = {} as any,
    exitState = 0;

(async function init() {

    try {

        let pkg: { name: string; version: string; };

        await new Promise((resolve, reject) =>
            fs.readFile(PATH.join(__dirname, '../', 'package.json'), 'utf8', async (err, data) => {
                if (err) return reject(err);
                pkg = JSON.parse(data);
                console.log(`\n Safe Backup v${pkg.version}\n Github: ${color.blue('https://github.com/scrwdrv/safe-backup', 'underscore')}\n`);
                resolve();
            })
        );

        await dir.mk(appDataPath);
        await parseParams();
        await handleConfig(Object.keys(config).length ? config : null);
        await dir.mk(config.output);
        await getPassword();

        const newerVersion = await updateCheck({ name: pkg.name, version: pkg.version }).catch((err) => {
            log.warn(`Failed to check for updates with npm`);
        });

        if (newerVersion)
            log.warn(`safe-backup v${newerVersion} released, ${color.yellowBright('`npm update -g safe-backup`')} to update`);
        else if (newerVersion === null) log.info(`safe-backup is up to date, good for you!`);

        if (semver.gt('11.6.0', process.version))
            return log.warn(`Node.js v11.6.0 or greater is required for safe-backup, please update your Node.js`), exit();

        forkWorkers();

        let promises: Promise<void>[] = [];

        for (let i = config.input.length; i--;)
            promises.push(
                backup({
                    input: config.input[i],
                    output: config.output,
                    passwordHash: keys.passwordHash,
                    publicKey: keys.public,
                    encryptedPrivateKey: keys.encryptedPrivate,
                    ignore: config.ignore
                }).then(() => {
                    if (config.watch)
                        normalizeInput(config.input[i], (type, p) => {
                            fs.stat(p, (err, stats) => {
                                if (err) return log.debug(err),
                                    log.error(`Error occurred while accessing [${formatPath(p)}]`);
                                backupDaemon(config.input[i]);
                                watchMod(config.input[i], stats.isFile());
                            });
                        });
                })
            )

        await Promise.all(promises);

        if (!config.watch) exit();

    } catch (err) {
        if (err) log.error(err);
        return exit();
    }

})();

function parseParams() {
    return new Promise<void>((resolve, quit) =>
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
                    }, {
                        param: 'save-password',
                        type: 'boolean',
                        optional: true,
                        alias: 's'
                    }
                ],
                id: 'regular'
            })
            .add({
                params: [
                    {
                        param: 'decrypt',
                        type: 'array-of-string',
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
                    param: 'reset-config',
                    type: 'boolean'
                },
                id: 'reset-config'
            })
            .add({
                params: {
                    param: 'reset-key',
                    type: 'boolean'
                },
                id: 'reset-key'
            })
            .add({
                params: {
                    param: 'log',
                    type: 'boolean',
                    alias: 'l'
                },
                id: 'log'
            })
            .add({
                params: {
                    param: 'export-config',
                    type: 'string',
                    default: PATH.join(process.cwd(), 'config.json')
                },
                id: 'export-config'
            })
            .add({
                params: {
                    param: 'import-config',
                    type: 'string'
                },
                id: 'import-config'
            })
            .add({
                params: {
                    param: 'export-key',
                    type: 'string',
                    default: PATH.join(process.cwd(), 'key.safe')
                },
                id: 'export-key'
            })
            .add({
                params: {
                    param: 'import-key',
                    type: 'string'
                },
                id: 'import-key'
            })
            .exec(async (err, args, id) => {
                if (err)
                    if (process.argv.length === 2) log.info('No parameters were found, restoring configuration...'), resolve();
                    else return console.log(err), console.log(helpText), quit();
                else switch (id) {
                    case 'regular':
                        config.input = args.input;
                        config.output = args.output;
                        config.watch = args.watch;
                        config.savePassword = args['save-password'] === false ? false : true;
                        config.ignore = [];
                        if (args.ignore)
                            for (let i = args.ignore.length; i--;) {
                                if (regex.isRegex(args.ignore[i]))
                                    config.ignore.push(args.ignore[i]);
                                else return log.error(`Invalid regex [${args.ignore[i]}]`), quit();
                            }
                        resolve();
                        break;
                    case 'decrypt':
                        const password = hashPassword(args.password ? args.password : await prompt.questions.getPassword()).toString('hex');

                        forkWorkers();

                        Promise.all((<string[]>args.decrypt).map(p => decrypt({
                            input: p,
                            passwordHash: password
                        }))).then(() => quit());
                        break;
                    case 'help':
                        console.log(helpText);
                        quit();
                        break;
                    case 'version':
                        quit();
                        break;
                    case 'config':
                        handleConfig().then(() => {
                            console.log(prettyJSON(config));
                            config = {} as any;
                            quit();
                        }).catch(err => {
                            console.log(`No configuration file is found`);
                            quit();
                        });
                        break;
                    case 'build-config':
                        await askQuestions().catch(quit);
                        resolve();
                        break;
                    case 'reset-config':
                        if (await prompt.questions.getYn(`Are you sure you wanna reset your configuration [Y/N]?`))
                            fs.unlink(PATH.join(appDataPath, 'config.json'), (err) => {
                                if (err)
                                    if (err.code === 'ENOENT') console.log('There is no config.json');
                                    else log.debug(err), console.log('Failed to delete config.json');
                                else console.log('config.json deleted');
                                quit();
                            });
                        else quit();
                        break;
                    case 'reset-key':
                        if (await prompt.questions.getYn(`Are you sure you wanna reset your key [Y/N]?`))
                            fs.unlink(PATH.join(appDataPath, 'key.safe'), (err) => {
                                if (err)
                                    if (err.code === 'ENOENT') console.log('There is no key');
                                    else log.debug(err), console.log('Failed to delete key.safe');
                                else console.log('key deleted');
                                quit();
                            });
                        else quit();
                        break;
                    case 'log':
                        console.log(PATH.join(appDataPath, 'logs'))
                        quit();
                        break;
                    case 'export-key':
                        fs.readFile(PATH.join(appDataPath, 'key.safe'), 'utf8', (err, data) => {
                            if (err) return log.debug(err), console.log('Key pair not found'), quit();
                            fs.writeFile(args['export-key'], data, (err) => {
                                if (err) log.debug(err), console.log('Failed to export key');
                                else console.log(`Key exported to ${PATH.resolve(args['export-key'])}`);
                                quit();
                            });
                        });
                        break;
                    case 'import-key':
                        fs.readFile(args['import-key'], (err, data) => {
                            if (err) return log.debug(err), console.log(`Key pair not found at ${PATH.resolve(args['import-key'])}`), quit();
                            try {
                                keys = decryptSafe(data);
                                if (!keys.public || !keys.encryptedPrivate) throw null;
                                fs.writeFile(PATH.join(appDataPath, 'key.safe'), data, (err) => {
                                    if (err) log.debug(err), console.log('Failed to import key');
                                    else console.log(`Key imported`);
                                    quit();
                                });
                            } catch (err) {
                                console.log(`Invalid key pair`);
                                quit();
                            }
                        })
                        break;
                    case 'export-config':
                        fs.readFile(PATH.join(appDataPath, 'config.json'), 'utf8', (err, data) => {
                            if (err) return log.debug(err), console.log('Configuration not found'), quit();
                            fs.writeFile(args['export-config'], data, (err) => {
                                if (err) log.debug(err), console.log('Failed to export configuration');
                                else console.log(`Configuration exported to ${PATH.resolve(args['export-config'])}`);
                                quit();
                            });
                        });
                        break;
                    case 'import-config':
                        fs.readFile(args['import-config'], 'utf8', (err, data) => {
                            if (err) return log.debug(err), console.log(`Configuration not found at ${PATH.resolve(args['import-config'])}`), quit();
                            try {
                                config = JSON.parse(data)
                                if (configValidator(config))
                                    fs.writeFile(PATH.join(appDataPath, 'config.json'), data, (err) => {
                                        if (err) log.debug(err), console.log('Failed to import configuration');
                                        else console.log(`Configuration imported`);
                                        quit();
                                    });
                                else throw null;
                            } catch (err) {
                                console.log(`Invalid configuration`);
                                quit();
                            }
                        })
                        break;
                }
            })
    )
}

function askQuestions() {
    return new Promise<void>(async (resolve, reject) => {
        log.info(`Start building configuration...`);
        try {
            config.input = await prompt.questions.getInput();
            config.output = await prompt.questions.getOutput();
            config.watch = await prompt.questions.getWatch();
            config.savePassword = await prompt.questions.getSavePassowrd();
            config.ignore = await prompt.questions.getIgnore();

            await handleConfig(config);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

function handleConfig(c?: Config) {
    return new Promise<void>((resolve, reject) => {
        if (c)
            if (configValidator(c))
                fs.writeFile(PATH.join(appDataPath, 'config.json'), JSON.stringify(c, null, 4), (err) => {
                    if (err) return reject(err);
                    checkPath();
                })
            else log.error(`Invalid configuration`), reject();
        else fs.readFile(PATH.join(appDataPath, 'config.json'), 'utf8', async (err, data) => {
            if (c === undefined) {
                if (err) return reject(err);
                else config = JSON.parse(data);
                resolve();
            } else {
                if (err) await askQuestions().catch(reject);
                else try {
                    config = JSON.parse(data);
                } catch (err) {
                    return log.error(`Invalid configuration`), reject(err)
                }

                if (configValidator(config)) checkPath();
                else log.error(`Invalid configuration`), reject();
            }
        });

        function checkPath() {
            for (let typeOfPath of ['input', 'output'])
                for (let i = config[typeOfPath].length; i--;) {
                    if (typeOfPath === 'input') normalizeInput(config[typeOfPath][i], (type, p) => {
                        if (!PATH.isAbsolute(p))
                            return log.error(`Path must be absolute [${formatPath(p)}]`), reject();
                        else config[typeOfPath][i] = config[typeOfPath][i].replace(/(?:\\|\/)$/, '')
                    })
                    else if (!PATH.isAbsolute(config[typeOfPath][i]))
                        return log.error(`Path must be absolute [${formatPath(config[typeOfPath][i])}]`), reject();
                    else config[typeOfPath][i] = config[typeOfPath][i].replace(/(?:\\|\/)$/, '')
                }
            resolve();
        }
    });
}

function configValidator(c: Config) {
    if (!c.input || !Array.isArray(c.input)) return false;
    if (!c.output || !Array.isArray(c.output)) return false;
    if (c.watch === undefined) return false;
    if (c.savePassword === undefined) return false;
    if (!c.ignore || !Array.isArray(c.ignore)) return false;
    return true;
}

function getPassword() {
    return new Promise<void>(async (resolve, reject) => {

        fs.readFile(PATH.join(appDataPath, 'key.safe'), (err, data) => {
            if (err) return log.warn(`Key pair not found, let's make one!`), setPassword();

            try {
                keys = decryptSafe(data);
                if (!keys.public || !keys.encryptedPrivate) throw null;
                if (!keys.passwordHash) log.warn(`Save password function disabled in this key`);
            } catch (err) {
                return reject(`Invalid key file`)
            }

            resolve();
        });

        async function setPassword() {

            const passwordHash = hashPassword(await prompt.questions.setPassword()).toString('hex');

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
                    passphrase: passwordHash
                }
            }, (err, publicKey, privateKey) => {
                if (err) return reject(err);

                const iv = crypto.randomBytes(12),
                    cipher = crypto.createCipheriv('aes-256-gcm', hashPassword(passwordHash, '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8'), iv),
                    safeCipher = crypto.createCipheriv('aes-256-ctr', 'c738b5fa19d2ddea7180a714c1e68079', 'b623a9863a81a793');

                keys.public = publicKey;
                keys.encryptedPrivate = Buffer.concat([cipher.update(privateKey), cipher.final(), cipher.getAuthTag(), iv]).toString('hex');

                let keySafe = { ...keys };

                if (config.savePassword) {
                    keys.passwordHash = passwordHash;
                    const hashIv = crypto.randomBytes(16),
                        hashCipher = crypto.createCipheriv('aes-256-ctr', 'eb67d2056248aa3c173a1472dd89b229', hashIv);
                    keySafe.passwordHash = Buffer.concat([crypto.randomBytes(19), hashCipher.update(passwordHash), hashCipher.final(), crypto.randomBytes(81), hashIv, crypto.randomBytes(1)]).toString('hex');
                }

                fs.writeFile(PATH.join(appDataPath, 'key.safe'),
                    Buffer.concat([safeCipher.update(JSON.stringify(keySafe)), safeCipher.final()]), (err) => {
                        if (err) return reject(err);
                        log.info(`Public & private key generated at ${PATH.join(appDataPath, 'key.safe')}`);
                        resolve();
                    });
            });
        }
    });
}

function forkWorkers() {
    for (let i = physicalCores < 1 ? 1 : physicalCores; i--;)
        forkWorker((i + 1).toString());
}

function forkWorker(id: string) {
    const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));

    worker.on('exit', () => {
        worker.removeAllListeners('message');
        const index = workers.indexOf(worker);
        if (index > -1) workers.splice(index, 1);
        forkWorker(id);
    });

    workers.push(worker);
    return worker;
}

function getWokrer() {
    const worker = workers.shift();
    workers.push(worker);
    return worker;
}

function decrypt(options: DecryptOptions) {
    return new Promise<void>(resolve => {
        const worker = getWokrer(),
            t = Date.now();
        running.push(worker.id);
        worker.sendJob('decrypt', options, (err, bytes, mods) => {
            if (err) log.debug(err), log.error(`Error occurred while decrypting, password may be incorrect [${formatPath(options.input)}]`);
            else {
                const decrypt = PATH.parse(options.input);
                log.info(`Decrypted, duration: ${formatSec(Date.now() - t)}s [${formatPath(options.input)}]`);
                log.info(`Your decrypted file/folder can be found at ${PATH.join(decrypt.dir, decrypt.name)}`);
            }
            const index = running.indexOf(worker.id);
            if (index > -1) running.splice(index, 1);
            resolve();
        });
    });
}

function backup(options: BackupOptions) {
    return new Promise<void>(resolve => {

        const worker = getWokrer(),
            t = Date.now();

        running.push(worker.id);

        normalizeInput(options.input, (type, p) => {
            options.input = p;
            worker.sendJob(type === 0 ? 'backup' : 'plainBackup', options, (err, bytes, mods) => {
                const tDiff = Date.now() - t;
                if (err) log.debug(err), log.error(`Error occurred while syncing [${formatPath(options.input)}]`), log.warn(`If this happens continuously, try to delete old backup file`);
                else log.info(`Synced [${formatSec(tDiff)}s][${formatBytes(bytes)}][${(bytes * options.output.length / 1048576 / (tDiff / 1000)).toFixed(2)} MBps][F:(+${mods.file[0]})(-${mods.file[1]})][D:(+${mods.directory[0]})(-${mods.directory[1]})][${formatPath(options.input)}]`);

                const index = running.indexOf(worker.id);
                if (index > -1) running.splice(index, 1);
                resolve();
            });
        });
    });
}

function backupDaemon(input: string) {
    if (exitState > 0) return;
    if (modified[input]) {
        backup({
            input: input,
            output: config.output,
            passwordHash: keys.passwordHash,
            publicKey: keys.public,
            encryptedPrivateKey: keys.encryptedPrivate,
            ignore: config.ignore
        }).then(() =>
            setTimeout(backupDaemon, config.watch * 1000, input));
        delete modified[input];
    } else setTimeout(backupDaemon, config.watch * 1000, input);
}

function watchMod(path: string, isFile: boolean, retry = 0) {
    normalizeInput(path, (type, p) => {
        if (retry > 5) {
            log.warn(`Stopped monitoring [${formatPath(p)}], next check in 10 mins...`);
            return setTimeout(watchMod, 600000, path, isFile, 0);
        }

        const watcher =
            watch(p, { recursive: !isFile }, (evt, file) => {
                const arr = file.split(PATH.sep);
                for (let i = regs.length; i--;)
                    if (regs[i].test(file) || arr.indexOfRegex(regs[i]) > -1) return;

                modified[path] = true;
                log.info(`Modification detected [${evt.toUpperCase()}][${formatPath(PATH.join(p, file))}]`);
            }).on('error', (err) => {
                log.debug(err);
                log.error(`Error occurred while monitoring [${formatPath(p)}], retry in 10 secs...`);
                watcher.removeAllListeners('close');
                watcher.close();
                clearTimeout(timeout);
                setTimeout(watchMod, 10000, path, isFile, retry + 1);
            }).on('close', () => {
                clearTimeout(timeout);
                setTimeout(watchMod, 10000, path, isFile, retry + 1);
            }),
            timeout = setTimeout(() => retry = 0, 60000),
            regs = config.ignore.map(str => {
                return regex.from(str)
            });
    })
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

    if (workers.length) log.info('Saving logs before exit...');

    Promise.all(workers.map(worker => {
        return new Promise<void>(resolve =>
            worker.sendJob('saveLog', null, () => {
                worker.removeAllListeners('exit').kill();
                resolve();
            })
        )
    })).then(() => {
        workers = [];
        exitState = 2;
        log.save().then(() => process.exit()).catch(() => exit(retry + 1));
    });
}

function decryptSafe(data: Buffer) {
    const safeDecipher = crypto.createDecipheriv('aes-256-ctr', 'c738b5fa19d2ddea7180a714c1e68079', 'b623a9863a81a793');

    let keys: Keys = JSON.parse(Buffer.concat([safeDecipher.update(data), safeDecipher.final()]).toString());

    if (keys.passwordHash) {
        const hashBuffer = Buffer.from(keys.passwordHash, 'hex'),
            hashCipher = crypto.createDecipheriv('aes-256-ctr', 'eb67d2056248aa3c173a1472dd89b229', hashBuffer.slice(-17, -1));
        keys.passwordHash = Buffer.concat([hashCipher.update(hashBuffer.slice(19, -98)), hashCipher.final()]).toString();
    }
    return keys;
}

function hashPassword(p: string, salt = '2ec8df9c3da9a2fe0b395cbc11c2dd54bc6a8dfec5ba2b7a96562aed17caffa9') {
    return crypto.createHash('sha256').update(p + salt).digest();
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

function prettyJSON(json: { [key: string]: any } | string) {
    const str = typeof json === 'string' ? json : JSON.stringify(json, null, 4);
    return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
            let cls: string;

            if (/^"/.test(match))
                if (/:$/.test(match)) cls = color.code.fg.cyanBright;
                else cls = color.code.fg.whiteBright;
            else cls = color.code.fg.magentaBright;

            return cls + match + color.code.reset;
        }
    );
}

function formatBytes(bytes: number) {
    const chars = 'KMGTP',
        e = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, e)).toFixed(2) + ' ' + chars.charAt(e - 1) + 'B';
}

function normalizeInput(path: string, cb: (type: 0 | 1, path: string) => void) {
    if (/^\*/.test(path)) return cb(1, path.slice(1))
    cb(0, path)
}