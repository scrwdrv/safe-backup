import * as folderEncrypt from 'folder-encrypt';
import * as fs from 'fs';
import args from './init';

class Backup {

    private options: {
        password: string;
        target: string;
    } = {} as any;

    constructor() {


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