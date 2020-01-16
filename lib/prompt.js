"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const readline = require("readline");
class Prompt {
    constructor() {
        this.questions = {
            getInput: (inputs = []) => {
                return new Promise(resolve => this.ask(`Enter absolute path of folder/file to backup: `).then(path => {
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
            setPassword: () => {
                return new Promise(resolve => this.ask('Set your password for encryption: ').then(password => this.questions.getYn(`Please confirm your password is \x1b[33m\x1b[1m${password}\x1b[0m [Y/N]? `).then(boo => {
                    if (boo)
                        resolve(password);
                    else
                        this.questions.getPassword().then(resolve);
                })));
            },
            getPassword: () => {
                return new Promise(resolve => this.ask('Enter your password for encryption: ').then(resolve));
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
            this.rl.question('\n' + question + '\n \x1b[36m\x1b[1m>\x1b[0m ', (val) => {
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