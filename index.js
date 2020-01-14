#!/usr/bin/env node
'use strict';
if (process.env.isWorker)
    Promise.resolve().then(() => require('./lib/worker'));
else
    Promise.resolve().then(() => require('./lib/master'));
process.on('SIGINT', () => { });