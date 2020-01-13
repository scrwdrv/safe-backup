import { loggerServer, loggerClient } from 'cluster-ipc-logger';
import physicalCores from 'physical-cores';
import CPC from 'worker-communication';
import cliParmas from 'cli-params';
import * as readline from 'readline';
import * as cluster from 'cluster';
import * as crypto from 'crypto';
import * as dir from 'recurdir';
import * as PATH from 'path';
import * as fs from 'fs';

declare global {
    interface Config {
        input: string[];
        output: string[];
        watch: number;
        passwordHash: string;
    }
    interface BackupOptions {
        input: string;
        output: string[];
        passwordHash: string;
    }
    interface DecryptOptions {
        input: string;
        passwordHash: string;
    }
}
`
Usage:
    backup --input <inputPath> [--password <password>] [--save-password [true|false]] [--watch [interval]] <outputPath>
    backup --input <inputPath1, inputPath2> <outputPath1, outputPath2>
    backup --help
    backup --version
    backup --config

Options:
    -i --input          Absolute path(s) of folder/file to backup, separate by comma.
    -p --password       Password for encryption (not recommended to use password in command line).
    -s --save-password  Save password for encryption so you don't have to enter it every time.
    -w --watch          Watch mode.
    -h --help           Show this screen.
    -v --version        Show version.
    -c --config         Show current configuration.
`
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

const cpc = new CPC(),
    prompt = new Prompt(),
    logServer = new loggerServer({
        debug: false,
        directory: './logs',
        saveInterval: 60000
    }),
    log = new loggerClient({
        system: 'master',
        cluster: 0
    }),
    salt = '2ec8df9c3da9a2fe0b395cbc11c2dd54bc6a8dfec5ba2b7a96562aed17caffa9';

let config: Config = {} as any,
    workers: cpcClusterWorker[] = [],
    running: number[] = [],
    modified: { [input: string]: number } = {},
    paused = false,
    nosave = false;

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

        function removeBackslash(arr: string[]) {
            for (let i = arr.length; i--;)
                arr[i] = arr[i].replace(/\\,/g, ',');
            return arr;
        }

        if (args['save-password'] === false) nosave = true;

        if (args.password)
            config.passwordHash = hashPassword(args.password);
        else await (function setPassword() {
            return new Promise(resolve => {
                prompt.ask('Set your password for encryption: ').then(password =>
                    prompt.ask(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(confirm => {
                        if (confirm.toLowerCase() === 'y') {
                            config.passwordHash = hashPassword(password);
                            prompt.end();
                            resolve();
                        }
                        else setPassword().then(resolve);
                    })
                );
            });
        })();
    } catch (err) {
        try {
            const args = cliParmas([
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
            else await new Promise(resolve =>
                prompt.ask('Enter your password: ').then(password => {
                    config.passwordHash = hashPassword(password);
                    prompt.end();
                    resolve();
                })
            )

            if (!PATH.isAbsolute(args.decrypt)) return log.error(`Path must be absolute [${formatPath(args.decrypt)}]`), exit();

            const t = Date.now();
            return forkWorker('1').sendJob('decrypt', { input: args.decrypt, passwordHash: config.passwordHash }, (err) => {
                if (err) log.debug(err), log.error(`Error occurred while decrypting [${formatPath(args.decrypt)}]`);
                else {
                    const decrypt = PATH.parse(args.decrypt);
                    log.info(`Decrypted, duration: ${formatSec(Date.now() - t)}s [${formatPath(args.decrypt)}]`);
                    log.info(`Your decrypted file/folder can be found at ${PATH.join(decrypt.dir, decrypt.name)}`);
                }
                exit();
            });

        } catch (err) {
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
    } catch (err) {
        log.debug(err);
        log.error(`Failed to initialize, see the log file for details`);
        return exit();
    }

    for (let i = physicalCores < 1 ? 1 : physicalCores; i--;)
        forkWorker((i + 1).toString());

    for (let i = config.input.length; i--;)
        backup({ input: config.input[i], output: config.output, passwordHash: config.passwordHash }).then(() => {
            if (config.watch) return fs.stat(config.input[i], (err, stats) => {
                if (err) return log.debug(err), log.error(`Error occurred while accessing [${formatPath(config.input[i])}]`);
                watchMod(config.input[i], stats.isFile());
            });
        });

    if (config.watch) {
        safetyGuard();
        backupDaemon();
    } else exit();

    process.on('SIGINT', () => exit());

    function backupDaemon() {
        setTimeout(() => {
            if (paused) return;
            let promises = []
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

    function backup(options: BackupOptions, mod?: number) {
        return new Promise((resolve) => {
            const worker = getWokrer(),
                t = Date.now();

            running.push(worker.id);
            worker.sendJob('backup', options, (err) => {
                if (err) log.debug(err), log.error(`Error occurred while syncing [${formatPath(options.input)}]`);
                else if (mod) log.info(`Synced ${mod} mod${mod > 1 ? 's' : ''}, duration: ${formatSec(Date.now() - t)}s [${formatPath(options.input)}]`);
                else log.info(`Synced, duration: ${formatSec(Date.now() - t)}s [${formatPath(options.input)}]`)
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

    function forkWorker(id: string) {
        log.info(`Forking worker[${id}]`);
        const worker = cpc.tunnel(cluster.fork({ workerId: id, isWorker: true }));
        worker.on('exit', () => {
            worker.removeAllListeners();
            const index = workers.indexOf(worker);
            if (index > -1) workers.splice(index, 1);
            log.error(`Worker[${id}] died, forking new one...`);
            forkWorker(id);
        });
        workers.push(worker);
        return worker;
    }

    function watchMod(path: string, isFile: boolean, retry = 0) {

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
    if (paused === null) return process.exit();
    paused = true;
    const l = running.length;

    if (l) {
        paused = null;
        if (config.watch) log.warn(`${l} task${l ? 's' : ''} still running, hang on...`),
            log.warn(`Ctrl+C again to force exit [NOT RECOMMENDED]`);
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (!running.length) clearInterval(interval), resolve();
            }, 500)
        });
    }

    for (let i = workers.length; i--;)
        workers.pop()
            .removeAllListeners()
            .kill();

    paused = null;
    if (config.watch) log.warn('Exiting...');
    if (retry > 10) return process.exit();
    setTimeout(() => logServer.save().then(process.exit).catch(() => exit(retry + 1)), 1000);
}

function handleConfig(c?: Config) {
    return new Promise<void>((resolve, reject) => {
        if (c) {
            if (nosave) {
                c = { ...c };
                delete c.passwordHash;
            }
            fs.writeFile('./config.json', JSON.stringify(c, null, 4), (err) => {
                if (err) return reject(err);
                resolve();
            });
        }
        else fs.readFile('./config.json', 'utf8', async (err, data) => {
            if (err) return reject(err);
            config = JSON.parse(data);
            if (!config.passwordHash) await (function setPassword() {
                return new Promise(resolve => {
                    prompt.ask('Enter your password for encryption: ').then(password =>
                        prompt.ask(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(confirm => {
                            if (confirm.toLowerCase() === 'y') {
                                config.passwordHash = hashPassword(password);
                                prompt.end();
                                resolve();
                            }
                            else setPassword().then(resolve);
                        })
                    );
                });
            })();
            resolve();
        });
    });
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

function hashPassword(p: string) {
    return crypto.createHash('sha256').update(p + salt).digest('hex');
}