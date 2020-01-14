import { loggerServer, loggerClient } from 'cluster-ipc-logger';
import physicalCores from 'physical-cores';
import CPC from 'worker-communication';
import CLIParams from 'cli-params';
import Prompt from './prompt';
import * as cluster from 'cluster';
import * as crypto from 'crypto';
import * as dir from 'recurdir';
import * as PATH from 'path';
import * as fs from 'fs';

__dirname = PATH.join(__dirname, '../');

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



const cpc = new CPC(),
    prompt = new Prompt(),
    logServer = new loggerServer({
        debug: false,
        directory: PATH.join(__dirname, 'logs'),
        saveInterval: 60000
    }),
    log = new loggerClient({
        system: 'master',
        cluster: 0
    }),
    salt = '2ec8df9c3da9a2fe0b395cbc11c2dd54bc6a8dfec5ba2b7a96562aed17caffa9',
    helpText = `
Usage:
    safe-backup --input <inputPath1> [inputPath2 [inputPath3 ...]] --output <outputPath1> [outputPath2 [outputPath3 ...]] [--password <password>] [--save-password [true|false]] [--watch [interval]] 
    safe-backup --decrypt <backupPath> [--password <password>]
    safe-backup --help
    safe-backup --version
    safe-backup --config
    safe-backup --build-config

Options:
    -i --input          Absolute path(s) of folder/file to backup, separate by space.
    -o --output         Absolute path(s) of folder to store encrypted file, separate by space.
    -p --password       Password for encryption/decryption (not recommended to use password in command line).
    -s --save-password  Save password for encryption so you don't have to enter it every time.
    -w --watch          Watch mode.
    -d --decrypt        Absolute path of .backup file to decrypt.
    -h --help           Show this screen.
    -v --version        Show version.
    -c --config         Show current configuration.
    -b --build-config   Start building configurations.
    `;

let config: Config = {} as any,
    workers: cpcClusterWorker[] = [],
    running: number[] = [],
    modified: { [input: string]: number } = {},
    paused = false,
    nosave = false;

process.on('SIGINT', () => exit());

(async function init() {
    await new Promise(resolve =>
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
                    },
                    {
                        param: 'output',
                        type: 'array-of-string',
                        alias: 'o'
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
            .exec(async (err, args, id) => {
                if (err)
                    if (process.argv.length === 2) log.info('No parameters were found, restoring configurations...')
                    else return log.error(err), console.log(helpText), exit();
                else switch (id) {
                    case 'regular':

                        config.input = args.input;
                        config.output = args.output;
                        config.watch = args.watch;

                        if (args['save-password'] === false) nosave = true;

                        config.passwordHash = hashPassword(args.password ? args.password : await prompt.questions.getPassword())

                        break;
                    case 'decrypt':

                        config.passwordHash = hashPassword(args.password ? args.password : await prompt.questions.getPassword())

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
                    case 'help':
                        console.log(helpText);
                        return exit();
                    case 'version':
                        console.log(`safe-backup version ${JSON.parse(fs.readFileSync(PATH.join(__dirname, 'package.json'), 'utf8')).version}`);
                        return exit();
                    case 'config':
                        return handleConfig().then(() => {
                            console.log(prettyJSON(config));
                            config = {} as any;
                            exit();
                        }).catch(err => {
                            log.debug(err);
                            console.log(`No configuration file is found`);
                            exit();
                        });
                    case 'build-config':
                        return askQuestions().then(resolve).catch(exit);
                }
                resolve();
            })
    );

    try {
        await handleConfig(Object.keys(config).length ? config : null);

        for (let typeOfPath of ['input', 'output'])
            for (let i = config[typeOfPath].length; i--;)
                if (!PATH.isAbsolute(config[typeOfPath][i]))
                    return log.error(`Path must be absolute [${formatPath(config[typeOfPath][i])}]`), exit();

        await dir.mk(config.output);
    } catch (err) {
        log.debug(err);
        log.error(`Failed to initialize, see log file for details`);
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
            .removeAllListeners('exit')
            .kill();

    paused = null;
    if (config.watch) log.warn('Exiting...');
    if (retry > 10) return process.exit();
    await halt(500);
    logServer.save().then(process.exit).catch(() => exit(retry + 1));
}

function handleConfig(c?: Config) {
    return new Promise<void>((resolve, reject) => {
        if (c) {
            if (nosave) {
                c = { ...c };
                delete c.passwordHash;
            }
            fs.writeFile(PATH.join(__dirname, 'config.json'), JSON.stringify(c, null, 4), (err) => {
                if (err) return reject(err);
                resolve();
            });
        } else fs.readFile(PATH.join(__dirname, 'config.json'), 'utf8', async (err, data) => {
            if (err) return resolve(await askQuestions().catch(reject));
            config = JSON.parse(data);
            if (c === undefined) return resolve();
            if (!config.passwordHash) config.passwordHash = hashPassword(await prompt.questions.getPassword());

            resolve();
        });
    });
}

function askQuestions() {
    return new Promise<void>(async (resolve, reject) => {
        log.info(`Start building configurations...`);
        try {
            await halt(500);
            config.input = await prompt.questions.getInput();
            config.output = await prompt.questions.getOutput();
            config.watch = await prompt.questions.getWatch();
            config.passwordHash = hashPassword(await prompt.questions.getPassword());
            if (!await prompt.questions.getSavePassword()) nosave = true;
            await handleConfig(config);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

function halt(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
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