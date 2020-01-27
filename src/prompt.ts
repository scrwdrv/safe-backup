import * as regex from 'simple-regex-toolkit';
import * as readline from 'readline';
import color from 'addcolor';

export default class Prompt {

    private rl: readline.Interface;

    private getRl() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        })
    }

    private ask(question: string) {
        return new Promise<string>(resolve => {
            if (!this.rl) this.getRl();
            this.rl.question('\n' + question + '\n' + color.cyanBright(' > '), (val) => {
                this.end();
                resolve(val);
            });
        });
    }

    private end() {
        this.rl.close();
        this.rl = null;
    }

    public questions = {
        getInput: (inputs = []) => {
            return new Promise<string[]>(resolve =>
                this.ask(`Enter absolute path of folder/file to backup (paths start with \`*\` will not be encrypted or packed): `).then(path => {
                    inputs.push(path);
                    this.questions.getYn(`More file/folder to backup [Y/N]? `).then(boo => {
                        if (boo) this.questions.getInput(inputs).then(resolve);
                        else resolve(inputs);
                    });
                })
            )
        },
        getOutput: (outputs = []) => {
            return new Promise<string[]>(resolve =>
                this.ask(`Enter absolute path of folder to store encrypted file: `).then(path => {
                    outputs.push(path);
                    this.questions.getYn(`More output destination [Y/N]? `).then(boo => {
                        if (boo) this.questions.getOutput(outputs).then(resolve);
                        else resolve(outputs);
                    });
                })
            )
        },
        getWatch: () => {
            return new Promise<number>(resolve =>
                this.questions.getYn(`Enable watch mode [Y/N]? `).then(boo => {
                    if (boo) resolve(60);
                    else resolve(null);
                })
            )
        },
        getSavePassowrd: () => {
            return new Promise<boolean>(resolve =>
                this.questions.getYn(`Whether to save your password (recommended on personal computer) [Y/N]? `).then(boo => {
                    if (boo) resolve(true);
                    else resolve(false);
                })
            )
        },
        getIgnore: (ignore = []) => {
            return new Promise<string[]>(resolve =>
                this.ask(`Exclude paths matches regular expression, e.g. /.+\\.log$/i [ENTER TO SKIP]: `).then(reg => {
                    if (!reg) return resolve([]);
                    if (regex.isRegex(reg)) ignore.push(reg);
                    else return console.log(color.redBright(`Invalid regex: ${reg}`)), this.questions.getIgnore(ignore).then(resolve);
                    this.questions.getYn(`More to exclude [Y/N]? `).then(boo => {
                        if (boo) this.questions.getIgnore(ignore).then(resolve);
                        else resolve(ignore);
                    });
                })
            )
        },
        setPassword: () => {
            return new Promise<string>(resolve =>
                this.ask('Set your password for encryption: ').then(password =>
                    this.questions.getYn(`Please confirm your password is ${color.yellowBright(password)} [Y/N]? `).then(boo => {
                        if (boo) resolve(password);
                        else this.questions.getPassword().then(resolve);
                    })
                )
            );
        },
        getPassword: () => {
            return new Promise<string>(resolve =>
                this.ask('Enter your password: ').then(resolve)
            );
        },
        getYn: (question: string) => {
            return new Promise<boolean>(resolve =>
                this.ask(question).then(confirm => {
                    if (confirm.toLowerCase() === 'y') resolve(true);
                    else if (confirm.toLowerCase() === 'n') resolve(false);
                    else this.questions.getYn(question).then(resolve);
                })
            )
        }
    }
}