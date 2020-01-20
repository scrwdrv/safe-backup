"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cluster_ipc_logger_1 = require("cluster-ipc-logger");
const physical_cores_1 = require("physical-cores");
const worker_communication_1 = require("worker-communication");
const cli_params_1 = require("cli-params");
const prompt_1 = require("./prompt");
const regex = require("simple-regex-toolkit");
const appdata_path_1 = require("appdata-path");
const cluster = require("cluster");
const crypto = require("crypto");
const dir = require("recurdir");
const PATH = require("path");
const fs = require("fs");
const keytar = require("keytar");
process.on('SIGINT', () => exit());
const appDataPath = appdata_path_1.default('safe-backup'), cpc = new worker_communication_1.default(), prompt = new prompt_1.default(), logServer = new cluster_ipc_logger_1.loggerServer({
    directory: PATH.join(appDataPath, 'logs'),
    saveInterval: 60000
}), log = new cluster_ipc_logger_1.loggerClient({
    system: 'master',
    cluster: 0,
    debug: false
}), helpText = `
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
    safe-backup --log

    safe-backup --export-key [path]
    safe-backup --import-key <path>

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
    -l --log            Show location of log files.

    --export-key        Export current key.
    --import-key        Import previously generated key.
    `;
let config = {}, workers = [], running = [], modified = {}, keys = {
    account: '',
    public: '',
    encryptedPrivate: ''
}, exitState = 0;
(async function init() {
    try {
        await dir.mk(appDataPath);
        await parseParams();
        await handleConfig(Object.keys(config).length ? config : null);
        await dir.mk(config.output);
        await getPassword();
        for (let i = physical_cores_1.default < 1 ? 1 : physical_cores_1.default; i--;)
            forkWorker((i + 1).toString());
        let promises = [];
        for (let i = config.input.length; i--;)
            promises.push(backup({
                input: config.input[i],
                output: config.output,
                account: keys.account,
                publicKey: keys.public,
                encryptedPrivateKey: keys.encryptedPrivate,
                ignore: config.ignore || []
            }).then(() => {
                if (config.watch)
                    return fs.stat(config.input[i], (err, stats) => {
                        if (err)
                            return log.debug(err),
                                log.error(`Error occurred while accessing [${formatPath(config.input[i])}]`);
                        backupDaemon(config.input[i]);
                        watchMod(config.input[i], stats.isFile());
                    });
            }));
        await Promise.all(promises);
        if (config.watch)
            safetyGuard();
        else
            exit();
    }
    catch (err) {
        if (err)
            log.error(err);
        return exit();
    }
})();
function parseParams() {
    return new Promise((resolve, reject) => new cli_params_1.default()
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
            if (process.argv.length === 2)
                log.info('No parameters were found, restoring configurations...'), resolve();
            else
                return console.log(err), console.log(helpText), reject();
        else
            switch (id) {
                case 'regular':
                    config.input = args.input;
                    config.output = args.output;
                    config.watch = args.watch;
                    if (args.ignore) {
                        config.ignore = [];
                        for (let i = args.ignore.length; i--;) {
                            if (regex.isRegex(args.ignore[i]))
                                config.ignore.push(args.ignore[i]);
                            else
                                return log.error(`Invalid regex [${args.ignore[i]}]`), reject();
                        }
                    }
                    resolve();
                    break;
                case 'decrypt':
                    if (!PATH.isAbsolute(args.decrypt))
                        return log.error(`Path must be absolute [${formatPath(args.decrypt)}]`), reject();
                    const passwordHash = hashPassword(args.password ? args.password : await prompt.questions.getPassword()).toString('hex');
                    const t = Date.now();
                    forkWorker('1').sendJob('decrypt', {
                        input: args.decrypt,
                        passwordHash: passwordHash
                    }, (err) => {
                        if (err)
                            log.debug(err), log.error(`Error occurred while decrypting, password may be incorrect [${formatPath(args.decrypt)}]`);
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
                    console.log(`safe-backup version ${JSON.parse(fs.readFileSync(PATH.join(__dirname, '../', 'package.json'), 'utf8')).version}`);
                    reject();
                    break;
                case 'config':
                    handleConfig().then(() => {
                        console.log(prettyJSON(config));
                        config = {};
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
                        fs.unlink(PATH.join(appDataPath, 'key.safe'), (err) => {
                            if (err)
                                if (err.code === 'ENOENT')
                                    console.log('There is no key');
                                else
                                    log.debug(err), console.log('Failed to delete key.safe');
                            else
                                console.log('key deleted');
                            reject();
                        });
                    else
                        reject();
                    break;
                case 'log':
                    console.log(PATH.join(appDataPath, 'logs'));
                    reject();
                    break;
                case 'export-key':
                    fs.readFile(PATH.join(appDataPath, 'key.safe'), 'utf8', (err, data) => {
                        if (err)
                            return log.debug(err), console.log('Key pair not found'), reject();
                        fs.writeFile(args['export-key'], data, (err) => {
                            if (err)
                                log.debug(err), console.log('Failed to export key');
                            else
                                console.log(`Key exported to  ${PATH.resolve(args['export-key'])}`);
                            reject();
                        });
                    });
                    break;
                case 'import-key':
                    fs.readFile(args['import-key'], (err, data) => {
                        if (err)
                            return log.debug(err), console.log(`Key pair not at ${PATH.resolve(args['import-key'])}`), reject();
                        try {
                            keys = decryptSafe(data);
                            if (!keys.public || !keys.encryptedPrivate || !keys.account)
                                throw null;
                            fs.writeFile(PATH.join(appDataPath, 'key.safe'), data, (err) => {
                                if (err)
                                    log.debug(err), console.log('Failed to import key');
                                else
                                    console.log(`Key imported`);
                                reject();
                            });
                        }
                        catch (err) {
                            console.log(`Invalid key pair`);
                            reject();
                        }
                    });
                    break;
            }
    }));
}
function askQuestions() {
    return new Promise(async (resolve, reject) => {
        log.info(`Start building configurations...`);
        try {
            config.input = await prompt.questions.getInput();
            config.output = await prompt.questions.getOutput();
            config.watch = await prompt.questions.getWatch();
            await handleConfig(config);
            resolve();
        }
        catch (err) {
            reject(err);
        }
    });
}
function handleConfig(c) {
    return new Promise((resolve, reject) => {
        if (c)
            fs.writeFile(PATH.join(appDataPath, 'config.json'), JSON.stringify(c, null, 4), (err) => {
                if (err)
                    return reject(err);
                checkPath();
            });
        else
            fs.readFile(PATH.join(appDataPath, 'config.json'), 'utf8', async (err, data) => {
                if (c === undefined) {
                    if (err)
                        return reject(err);
                    else
                        config = JSON.parse(data);
                    resolve();
                }
                else {
                    if (err)
                        await askQuestions().catch(reject);
                    else
                        config = JSON.parse(data);
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
    return new Promise(async (resolve, reject) => {
        fs.readFile(PATH.join(appDataPath, 'key.safe'), (err, data) => {
            if (err)
                return log.warn(`Key pair not found, let's make one!`), setPassword();
            try {
                keys = decryptSafe(data);
                if (!keys.public || !keys.encryptedPrivate || !keys.account)
                    throw null;
            }
            catch (err) {
                return reject(`Invalid key file`);
            }
            resolve();
        });
        async function setPassword() {
            const hash = hashPassword(await prompt.questions.setPassword()).toString('hex'), account = crypto.randomBytes(32).toString('hex');
            try {
                await keytar.setPassword('safe-backup', account, hash);
            }
            catch (err) {
                log.warn(`Failed to save password to system keychain, is libsecret correctly installed?`);
                return reject(err);
            }
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
                if (err)
                    return reject(err);
                const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', hashPassword(hash, '1f3c11d0324d12d5b9cb792d887843d11d74e37e6f7c4431674ebf7c5829b3b8'), iv), safeCipher = crypto.createCipheriv('aes-256-ctr', 'c738b5fa19d2ddea7180a714c1e68079', 'b623a9863a81a793');
                keys.account = account;
                keys.public = publicKey;
                keys.encryptedPrivate = Buffer.concat([cipher.update(privateKey), cipher.final(), cipher.getAuthTag(), iv]).toString('hex');
                fs.writeFile(PATH.join(appDataPath, 'key.safe'), Buffer.concat([safeCipher.update(JSON.stringify(keys)), safeCipher.final()]), (err) => {
                    if (err)
                        return reject(err);
                    log.info(`Public & private key generated at ${PATH.join(appDataPath, 'key.safe')}`);
                    resolve();
                });
            });
        }
    });
}
function forkWorker(id) {
    log.info(`Forking worker[${id}]`);
    const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));
    worker.on('exit', () => {
        worker.removeAllListeners('message');
        const index = workers.indexOf(worker);
        if (index > -1)
            workers.splice(index, 1);
        log.error(`Worker[${id}] died, forking new one...`);
        forkWorker(id);
    });
    workers.push(worker);
    return worker;
}
function backup(options) {
    return new Promise((resolve) => {
        const worker = getWokrer(), t = Date.now();
        running.push(worker.id);
        worker.sendJob('backup', options, (err, bytes, mods) => {
            if (err)
                log.debug(err), log.error(`Error occurred while syncing [${formatPath(options.input)}]`), log.warn(`If this happens continuously, try to delete old backup file`);
            else
                log.info(`Synced [${formatSec(Date.now() - t)}s][${formatBytes(bytes)}][F:(+${mods.file[0]})(-${mods.file[1]})][D:(+${mods.directory[0]})(-${mods.directory[1]})][${formatPath(options.input)}]`);
            const index = running.indexOf(worker.id);
            if (index > -1)
                running.splice(index, 1);
            resolve();
        });
    });
    function getWokrer() {
        const worker = workers.shift();
        workers.push(worker);
        return worker;
    }
}
function backupDaemon(input) {
    if (exitState > 0)
        return;
    if (modified[input]) {
        backup({
            input: input,
            output: config.output,
            account: keys.account,
            publicKey: keys.public,
            encryptedPrivateKey: keys.encryptedPrivate,
            ignore: config.ignore || []
        }).then(() => setTimeout(backupDaemon, config.watch * 1000, input));
        delete modified[input];
    }
    else
        setTimeout(backupDaemon, config.watch * 1000, input);
}
function watchMod(path, isFile, retry = 0) {
    if (retry > 5) {
        log.warn(`Stopped monitoring [${formatPath(path)}], next check in 10 mins...`);
        return setTimeout(watchMod, 600000, path, isFile, 0);
    }
    const watcher = fs.watch(path, { recursive: !isFile }, (evt, file) => {
        if (regs) {
            const arr = file.split(PATH.sep);
            for (let i = regs.length; i--;)
                if (regs[i].test(file) || arr.indexOfRegex(regs[i]) > -1)
                    return;
        }
        modified[path] = true;
        log.info(`Modification detected [${evt.toUpperCase()}][${formatPath(PATH.join(path, file))}]`);
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
    }), timeout = setTimeout(() => retry = 0, 60000), regs = config.ignore ? config.ignore.map(str => {
        return regex.from(str);
    }) : null;
}
function safetyGuard() {
    let exited = false, errorsCount = 0;
    logServer.on('error', () => {
        if (exited)
            return;
        errorsCount++;
        if (errorsCount > config.input.length * 10) {
            log.error(`Too many errors occurred, something might went wrong, exiting...`);
            exited = true;
            exit();
        }
    });
    setInterval(() => {
        errorsCount = 0;
    }, 60000);
}
async function exit(retry = 0) {
    if (exitState === 2 || retry > 3)
        return process.exit();
    exitState = 1;
    const l = running.length;
    if (l) {
        exitState = 2;
        log.warn(`${l} task${l > 1 ? 's' : ''} still running, hang on...`);
        log.warn(`Ctrl+C again to force exit [NOT RECOMMENDED]`);
        await new Promise(resolve => {
            const interval = setInterval(() => {
                if (!running.length)
                    clearInterval(interval), resolve();
            }, 250);
        });
    }
    for (let i = workers.length; i--;)
        workers.pop()
            .removeAllListeners('exit')
            .kill();
    exitState = 2;
    logServer.save().then(process.exit).catch(() => exit(retry + 1));
}
function decryptSafe(data) {
    const safeDecipher = crypto.createCipheriv('aes-256-ctr', 'c738b5fa19d2ddea7180a714c1e68079', 'b623a9863a81a793');
    return JSON.parse(Buffer.concat([safeDecipher.update(data), safeDecipher.final()]).toString());
}
function hashPassword(p, salt = '2ec8df9c3da9a2fe0b395cbc11c2dd54bc6a8dfec5ba2b7a96562aed17caffa9') {
    return crypto.createHash('sha256').update(p + salt).digest();
}
function formatSec(ms) {
    return (ms / 1000).toFixed(2);
}
function formatPath(p, max = 30) {
    const l = p.length;
    if (l > max) {
        const n = (max - 3) / 2;
        p = p.slice(0, Math.ceil(n)) + '...' + p.slice(-Math.floor(n));
    }
    return p;
}
function prettyJSON(json) {
    const str = typeof json === 'string' ? json : JSON.stringify(json, null, 4);
    return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
        let cls = '\x1b[35m\x1b[1m';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = '\x1b[36m\x1b[1m';
            }
            else {
                cls = '\x1b[37m\x1b[1m';
            }
        }
        return cls + match + '\x1b[0m';
    });
}
function formatBytes(bytes) {
    const chars = 'KMGTP', e = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, e)).toFixed(2) + ' ' + chars.charAt(e - 1) + 'B';
}
