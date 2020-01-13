import { loggerServer, loggerClient } from 'cluster-ipc-logger';
import physicalCores from 'physical-cores';
import CPC from 'worker-communication';
import cliParmas from 'cli-params';
import * as readline from 'readline';
import * as cluster from 'cluster';
import * as crypto from 'crypto';
import * as dir from 'recurdir';
import * as fs from 'fs';

type Config = {
    input: string[];
    output: string[];
    watch: number;
    passwordHash: string;
};

class Prompt {
    private rl: readline.Interface;
    private getRl() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    ask(question: string) {
        return new Promise<string>(resolve => {
            if (!this.rl) this.getRl();
            this.rl.question(question, resolve);
        });
    }

    end() {
        this.rl.close();
        this.rl = null;
    }
}

const
    logServer = new loggerServer({
        debug: false,
        directory: './log',
        saveInterval: 60000
    }),
    log = new loggerClient({
        system: 'master',
        cluster: 0
    }),
    cpc = new CPC(),
    prompt = new Prompt();

let config: Config = null,
    workers: cpcClusterWorker[] = [];

(async function init() {
    try {
        const args = cliParmas([
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
        }

        if (args.password)
            config.passwordHash = crypto.createHash('sha256').update(args.password).digest('hex');
        else await (function setPassword() {
            return new Promise((resolve) => {
                prompt.ask('Set your password for encryption: ').then(password =>
                    prompt.ask(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(confirm => {
                        if (confirm.toLowerCase() === 'y') {
                            config.passwordHash = crypto.createHash('sha256').update(password).digest('hex');
                            prompt.end();
                            resolve();
                        }
                        else setPassword().then(resolve);
                    })
                );
            });
        })();
    } catch (err) /* no args were found */ {
        log.info('No parameters were found, restoring last known good configuration...');
    }

    try {
        await handleConfig(config);
        await dir.mk(config.output);
    } catch (err) {
        log.debug(err);
        log.error(`Failed to initialize, see the log file for details`);
        return exit();
    }

    for (let i = physicalCores < 1 ? 1 : physicalCores; i--;)
        forkWorker((i + 1).toString());

    for (let i = config.input.length; i--;) fs.stat(config.input[i], (err, stats) => {
        if (err) return log.debug(err), log.error(`Error occurred while accessing input [${config.input[i]}]`);
        watchPath(config.input[i], stats.isFile());
    });

    safetyGuard();

    function forkWorker(id: string) {
        const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));
        worker.on('exit', () => {
            worker.removeAllListeners();
            const indexOfWorker = workers.indexOf(worker);
            if (indexOfWorker > -1) workers.splice(indexOfWorker, 1);
            log.error(`Worker[${id}] died, forking new one...`);
            forkWorker(id);
        });
        workers.push(worker);
    }

    function watchPath(path: string, isFile: boolean, retry = 0) {
        if (retry > 10) return log.warn(`Stopped monitoring input [${path}]`);

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
    let exited = false,
        errorsCount = 0;

    logServer.on('error', () => {
        if (exited) return;
        errorsCount++;
        if (errorsCount > 10) {
            log.error(`Too many errors occurred, something might went wrong, exiting...`)
            exited = true;
            exit();
        }
    });

    setInterval(() => {
        errorsCount = 0;
    }, 60000);
}

function exit(retry: number = 0) {
    if (retry > 10) return process.exit();
    for (let i = workers.length; i--;)
        workers.pop()
            .removeAllListeners()
            .kill();
    logServer.save().then(process.exit).catch(() => exit(retry + 1));
}

function handleConfig(c?: Config) {
    return new Promise<void>((resolve, reject) => {
        if (c) fs.writeFile('./config.json', JSON.stringify(c, null, 4), (err) => {
            if (err) return reject(err);
            resolve();
        });
        else fs.readFile('./config.json', 'utf8', (err, data) => {
            if (err) return reject(err);
            config = JSON.parse(data);
            resolve();
        });
    })
}