#!/usr/bin/env node
"use strict";
if (process.env.isWorker)
    Promise.resolve().then(() => require('./worker'));
else
    Promise.resolve().then(() => require('./master'));
process.on('SIGINT', () => { });
