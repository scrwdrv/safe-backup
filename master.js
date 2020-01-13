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
const logServer = new cluster_ipc_logger_1.loggerServer({
    debug: false,
    directory: './log',
    saveInterval: 60000
}), log = new cluster_ipc_logger_1.loggerClient({
    system: 'master',
    cluster: 0
}), cpc = new worker_communication_1.default(), prompt = new Prompt();
let config = null, workers = [];
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
            }
        ], {
            param: 'output',
            type: 'string'
        });
        config = {
            input: args.input.split(','),
            output: args.output.split(','),
            watch: args.watch,
            passwordHash: null
        };
        if (args.password)
            config.passwordHash = crypto.createHash('sha256').update(args.password).digest('hex');
        else
            await (function setPassword() {
                return new Promise((resolve) => {
                    prompt.ask('Set your password for encryption: ').then(password => prompt.ask(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(confirm => {
                        if (confirm.toLowerCase() === 'y') {
                            config.passwordHash = crypto.createHash('sha256').update(password).digest('hex');
                            prompt.end();
                            resolve();
                        }
                        else
                            setPassword().then(resolve);
                    }));
                });
            })();
    }
    catch (err) /* no args were found */ {
        log.info('No parameters were found, restoring last known good configuration...');
    }
    try {
        await handleConfig(config);
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
        fs.stat(config.input[i], (err, stats) => {
            if (err)
                return log.debug(err), log.error(`Error occurred while accessing input [${config.input[i]}]`);
            watchPath(config.input[i], stats.isFile());
        });
    safetyGuard();
    function forkWorker(id) {
        const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));
        worker.on('exit', () => {
            worker.removeAllListeners();
            const indexOfWorker = workers.indexOf(worker);
            if (indexOfWorker > -1)
                workers.splice(indexOfWorker, 1);
            log.error(`Worker[${id}] died, forking new one...`);
            forkWorker(id);
        });
        workers.push(worker);
    }
    function watchPath(path, isFile, retry = 0) {
        if (retry > 10)
            return log.warn(`Stopped monitoring input [${path}]`);
        const watcher = fs.watch(path, { recursive: !isFile }, (evt, file) => {
        }).on('error', (err) => {
            log.debug(err);
            log.error(`Error occurred while monitoring input [${path}], retry in 10 secs...`);
            watcher.removeAllListeners();
            watcher.close();
            clearTimeout(timeout);
            setTimeout(watchPath, 10000, path, isFile, retry + 1);
        }).on('close', () => {
            clearTimeout(timeout);
            setTimeout(watchPath, 10000, path, isFile, retry + 1);
        }), timeout = setTimeout(() => {
            retry = 0;
        }, 60000);
        function getWokrer() {
            const worker = workers.shift();
            workers.push(worker);
            return worker;
        }
    }
})();
function safetyGuard() {
    let exited = false, errorsCount = 0;
    logServer.on('error', () => {
        if (exited)
            return;
        errorsCount++;
        if (errorsCount > 10) {
            log.error(`Too many errors occurred, something might went wrong, exiting...`);
            exited = true;
            exit();
        }
    });
    setInterval(() => {
        errorsCount = 0;
    }, 60000);
}
function exit(retry = 0) {
    if (retry > 10)
        return process.exit();
    for (let i = workers.length; i--;)
        workers.pop()
            .removeAllListeners()
            .kill();
    logServer.save().then(process.exit).catch(() => exit(retry + 1));
}
function handleConfig(c) {
    return new Promise((resolve, reject) => {
        if (c)
            fs.writeFile('./config.json', JSON.stringify(c, null, 4), (err) => {
                if (err)
                    return reject(err);
                resolve();
            });
        else
            fs.readFile('./config.json', 'utf8', (err, data) => {
                if (err)
                    return reject(err);
                config = JSON.parse(data);
                resolve();
            });
    });
}
