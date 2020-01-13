import * as folderEncrypt from 'folder-encrypt';
import { loggerClient } from 'cluster-ipc-logger';
import CPC from 'worker-communication';
import * as fs from 'fs';

const log =
    new loggerClient({
        system: 'worker', cluster: process.env.workerId
    }),
    cpc = new CPC();

cpc.onMaster('backup', (req, res) => {

})

log.info(`Worker[${process.env.workerId}] initialized`);

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