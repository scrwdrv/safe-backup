"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cluster_ipc_logger_1 = require("cluster-ipc-logger");
const physical_cores_1 = require("physical-cores");
const worker_communication_1 = require("worker-communication");
const cli_params_1 = require("cli-params");
const readline = require("readline");
const cluster = require("cluster");
const crypto = require("crypto");
const dir = require("recurdir");
const PATH = require("path");
const fs = require("fs");
class Prompt {
    getRl() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    ask(question) {
        return new Promise(resolve => {
            if (!this.rl)
                this.getRl();
            this.rl.question(question, resolve);
        });
    }
    end() {
        this.rl.close();
        this.rl = null;
    }
}
const cpc = new worker_communication_1.default(), prompt = new Prompt(), logServer = new cluster_ipc_logger_1.loggerServer({
    debug: false,
    directory: './logs',
    saveInterval: 60000
}), log = new cluster_ipc_logger_1.loggerClient({
    system: 'master',
    cluster: 0
}), salt = '2ec8df9c3da9a2fe0b395cbc11c2dd54bc6a8dfec5ba2b7a96562aed17caffa9';
let config = {}, workers = [], running = [], modified = {}, paused = false, nosave = false;
(async function init() {
    try {
        const args = cli_params_1.default([
            {
                param: 'input',
                type: 'string',
                alias: 'i'
            }, {
                param: 'watch',
                type: 'int',
                optional: true,
                default: 60,
                alias: 'w'
            }, {
                param: 'password',
                type: 'string',
                optional: true,
                alias: 'p'
            }, {
                param: 'save-password',
                type: 'boolean',
                optional: true,
                alias: 's'
            }
        ], {
            param: 'output',
            type: 'string'
        });
        config.input = removeBackslash(args.input.split(/\s*,\s*/));
        config.output = removeBackslash(args.output.split(/\s*,\s*/));
        config.watch = args.watch;
        function removeBackslash(arr) {
            for (let i = arr.length; i--;)
                arr[i] = arr[i].replace(/\\,/g, ',');
            return arr;
        }
        if (args['save-password'] === false)
            nosave = true;
        if (args.password)
            config.passwordHash = hashPassword(args.password);
        else
            await (function setPassword() {
                return new Promise(resolve => {
                    prompt.ask('Set your password for encryption: ').then(password => prompt.ask(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(confirm => {
                        if (confirm.toLowerCase() === 'y') {
                            config.passwordHash = hashPassword(password);
                            prompt.end();
                            resolve();
                        }
                        else
                            setPassword().then(resolve);
                    }));
                });
            })();
    }
    catch (err) {
        try {
            const args = cli_params_1.default([
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
            ]);
            if (args.password)
                config.passwordHash = hashPassword(args.password);
            else
                await new Promise(resolve => prompt.ask('Enter your password: ').then(password => {
                    config.passwordHash = hashPassword(password);
                    prompt.end();
                    resolve();
                }));
            if (!PATH.isAbsolute(args.decrypt))
                return log.error(`Path must be absolute [${formatPath(args.decrypt)}]`), exit();
            const t = Date.now();
            return forkWorker('1').sendJob('decrypt', { input: args.decrypt, passwordHash: config.passwordHash }, (err) => {
                if (err)
                    log.debug(err), log.error(`Error occurred while decrypting [${formatPath(args.decrypt)}]`);
                else {
                    const decrypt = PATH.parse(args.decrypt);
                    log.info(`Decrypted, duration: ${formatSec(Date.now() - t)}s [${formatPath(args.decrypt)}]`);
                    log.info(`Your decrypted file/folder can be found at ${PATH.join(decrypt.dir, decrypt.name)}`);
                }
                exit();
            });
        }
        catch (err) {
            log.info('No parameters were found, restoring configurations...');
        }
    }
    try {
        await handleConfig(Object.keys(config).length ? config : null);
        for (let typeOfPath of ['input', 'output'])
            for (let i = config[typeOfPath].length; i--;)
                if (!PATH.isAbsolute(config[typeOfPath][i]))
                    return log.error(`Path must be absolute [${formatPath(config[typeOfPath][i])}]`), exit();
        await dir.mk(config.output);
    }
    catch (err) {
        log.debug(err);
        log.error(`Failed to initialize, see the log file for details`);
        return exit();
    }
    for (let i = physical_cores_1.default < 1 ? 1 : physical_cores_1.default; i--;)
        forkWorker((i + 1).toString());
    for (let i = config.input.length; i--;)
        backup({ input: config.input[i], output: config.output, passwordHash: config.passwordHash }).then(() => {
            if (config.watch)
                return fs.stat(config.input[i], (err, stats) => {
                    if (err)
                        return log.debug(err), log.error(`Error occurred while accessing [${formatPath(config.input[i])}]`);
                    watchMod(config.input[i], stats.isFile());
                });
        });
    if (config.watch) {
        safetyGuard();
        backupDaemon();
    }
    else
        exit();
    process.on('SIGINT', () => exit());
    function backupDaemon() {
        setTimeout(() => {
            if (paused)
                return;
            let promises = [];
            for (let input in modified) {
                promises.push(backup({
                    input: input,
                    output: config.output,
                    passwordHash: config.passwordHash
                }, modified[input]));
                delete modified[input];
            }
            Promise.all(promises).then(backupDaemon);
        }, config.watch * 1000);
    }
    function backup(options, mod) {
        return new Promise((resolve) => {
            const worker = getWokrer(), t = Date.now();
            running.push(worker.id);
            worker.sendJob('backup', options, (err) => {
                if (err)
                    log.debug(err), log.error(`Error occurred while syncing [${formatPath(options.input)}]`);
                else if (mod)
                    log.info(`Synced ${mod} mod${mod > 1 ? 's' : ''}, duration: ${formatSec(Date.now() - t)}s [${formatPath(options.input)}]`);
                else
                    log.info(`Synced, duration: ${formatSec(Date.now() - t)}s [${formatPath(options.input)}]`);
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
    function forkWorker(id) {
        log.info(`Forking worker[${id}]`);
        const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));
        worker.on('exit', () => {
            worker.removeAllListeners();
            const index = workers.indexOf(worker);
            if (index > -1)
                workers.splice(index, 1);
            log.error(`Worker[${id}] died, forking new one...`);
            forkWorker(id);
        });
        workers.push(worker);
        return worker;
    }
    function watchMod(path, isFile, retry = 0) {
        if (retry > 5) {
            log.warn(`Stopped monitoring [${formatPath(path)}], next check in 10 mins...`);
            return setTimeout(watchMod, 600000, path, isFile, 0);
        }
        const watcher = fs.watch(path, { recursive: !isFile }, (evt, file) => {
            modified[path] ? modified[path]++ : modified[path] = 1;
            log.info(`File modified [${evt.toUpperCase()}][${formatPath(PATH.join(path, file))}]`);
        }).on('error', (err) => {
            log.debug(err);
            log.error(`Error occurred while monitoring [${formatPath(path)}], retry in 10 secs...`);
            watcher.removeAllListeners();
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
})();
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
    if (paused === null)
        return process.exit();
    paused = true;
    const l = running.length;
    if (l) {
        paused = null;
        if (config.watch)
            log.warn(`${l} task${l ? 's' : ''} still running, hang on...`),
                log.warn(`Ctrl+C again to force exit [NOT RECOMMENDED]`);
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (!running.length)
                    clearInterval(interval), resolve();
            }, 500);
        });
    }
    for (let i = workers.length; i--;)
        workers.pop()
            .removeAllListeners()
            .kill();
    paused = null;
    if (config.watch)
        log.warn('Exiting...');
    if (retry > 10)
        return process.exit();
    setTimeout(() => logServer.save().then(process.exit).catch(() => exit(retry + 1)), 1000);
}
function handleConfig(c) {
    return new Promise((resolve, reject) => {
        if (c) {
            if (nosave) {
                c = { ...c };
                delete c.passwordHash;
            }
            fs.writeFile('./config.json', JSON.stringify(c, null, 4), (err) => {
                if (err)
                    return reject(err);
                resolve();
            });
        }
        else
            fs.readFile('./config.json', 'utf8', async (err, data) => {
                if (err)
                    return reject(err);
                config = JSON.parse(data);
                if (!config.passwordHash)
                    await (function setPassword() {
                        return new Promise(resolve => {
                            prompt.ask('Enter your password for encryption: ').then(password => prompt.ask(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(confirm => {
                                if (confirm.toLowerCase() === 'y') {
                                    config.passwordHash = hashPassword(password);
                                    prompt.end();
                                    resolve();
                                }
                                else
                                    setPassword().then(resolve);
                            }));
                        });
                    })();
                resolve();
            });
    });
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
function hashPassword(p) {
    return crypto.createHash('sha256').update(p + salt).digest('hex');
}
