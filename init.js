"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cli_params_1 = require("cli-params");
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
    }], {
    param: 'target',
    type: 'string'
});
exports.default = args;
