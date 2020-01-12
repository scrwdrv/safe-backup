"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const folderEncrypt = require("folder-encrypt");
class Backup {
    constructor() {
        this.options = {};
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
