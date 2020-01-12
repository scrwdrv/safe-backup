import * as folderEncrypt from 'folder-encrypt';
import cliParmas from 'cli-params';
import * as fs from 'fs';

class Backup {

    private options: {
        password: string;
        target: string;
    } = {} as any;

    constructor() {
        let args = cliParmas([{
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
        }], {
            param: 'target',
            type: 'string'
        });


    }

    copy() {

    }

    encrypt(input: string) {
        folderEncrypt.encrypt({
            input: input,
            password: this.options.password
        })
    }
}