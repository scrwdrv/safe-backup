"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const folderEncrypt = require("folder-encrypt");
const cli_params_1 = require("cli-params");
class Backup {
    constructor() {
        this.options = {};
        let args = cli_params_1.default([{
                param: 'input',
                type: 'string',
                optional: true,
                alias: 'i'
            }, {
                param: 'watch',
                type: 'int',
                optional: true,
                default: 60,
                alias: 'w'
            }], 'root');
        args.root;
    }
    copy() {
    }
    encrypt(input) {
        folderEncrypt.encrypt({
            input: input,
            password: this.options.password
        });
    }
}
