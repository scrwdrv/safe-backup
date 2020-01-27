"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const regex = require("simple-regex-toolkit");
const readline = require("readline");
const addcolor_1 = require("addcolor");
class Prompt {
    constructor() {
        this.questions = {
            getInput: (inputs = []) => {
                return new Promise(resolve => this.ask(`Enter absolute path of folder/file to backup (paths start with \`*\` will not be encrypted or packed): `).then(path => {
                    inputs.push(path);
                    this.questions.getYn(`More file/folder to backup [Y/N]? `).then(boo => {
                        if (boo)
                            this.questions.getInput(inputs).then(resolve);
                        else
                            resolve(inputs);
                    });
                }));
            },
            getOutput: (outputs = []) => {
                return new Promise(resolve => this.ask(`Enter absolute path of folder to store encrypted file: `).then(path => {
                    outputs.push(path);
                    this.questions.getYn(`More output destination [Y/N]? `).then(boo => {
                        if (boo)
                            this.questions.getOutput(outputs).then(resolve);
                        else
                            resolve(outputs);
                    });
                }));
            },
            getWatch: () => {
                return new Promise(resolve => this.questions.getYn(`Enable watch mode [Y/N]? `).then(boo => {
                    if (boo)
                        resolve(60);
                    else
                        resolve(null);
                }));
            },
            getSavePassowrd: () => {
                return new Promise(resolve => this.questions.getYn(`Whether to save your password (recommended on personal computer) [Y/N]? `).then(boo => {
                    if (boo)
                        resolve(true);
                    else
                        resolve(false);
                }));
            },
            getIgnore: (ignore = []) => {
                return new Promise(resolve => this.ask(`Exclude paths matches regular expression, e.g. /.+\\.log$/i [ENTER TO SKIP]: `).then(reg => {
                    if (!reg)
                        return resolve([]);
                    if (regex.isRegex(reg))
                        ignore.push(reg);
                    else
                        return console.log(addcolor_1.default.redBright(`Invalid regex: ${reg}`)), this.questions.getIgnore(ignore).then(resolve);
                    this.questions.getYn(`More to exclude [Y/N]? `).then(boo => {
                        if (boo)
                            this.questions.getIgnore(ignore).then(resolve);
                        else
                            resolve(ignore);
                    });
                }));
            },
            setPassword: () => {
                return new Promise(resolve => this.ask('Set your password for encryption: ').then(password => this.questions.getYn(`Please confirm your password is ${addcolor_1.default.yellowBright(password)} [Y/N]? `).then(boo => {
                    if (boo)
                        resolve(password);
                    else
                        this.questions.getPassword().then(resolve);
                })));
            },
            getPassword: () => {
                return new Promise(resolve => this.ask('Enter your password: ').then(resolve));
            },
            getYn: (question) => {
                return new Promise(resolve => this.ask(question).then(confirm => {
                    if (confirm.toLowerCase() === 'y')
                        resolve(true);
                    else if (confirm.toLowerCase() === 'n')
                        resolve(false);
                    else
                        this.questions.getYn(question).then(resolve);
                }));
            }
        };
    }
    getRl() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });
    }
    ask(question) {
        return new Promise(resolve => {
            if (!this.rl)
                this.getRl();
            this.rl.question('\n' + question + '\n' + addcolor_1.default.cyanBright(' > '), (val) => {
                this.end();
                resolve(val);
            });
        });
    }
    end() {
        this.rl.close();
        this.rl = null;
    }
}
exports.default = Prompt;
