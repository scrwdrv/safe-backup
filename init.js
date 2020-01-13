"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cli_params_1 = require("cli-params");
const cluster_ipc_logger_1 = require("cluster-ipc-logger");
const fs = require("fs");
const crypto = require("crypto");
const readline = require("readline");
const physical_cores_1 = require("physical-cores");
class Prompt {
    getRl() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    ask(question) {
        return new Promise((resolve, reject) => {
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
}), prompt = new Prompt();
let config = null;
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
    await handleConfig(config);
    for (let i = physical_cores_1.default; i--;) {
    }
})();
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
