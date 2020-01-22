#!/usr/bin/env node
'use strict';

if (process.env.isWorker) require('./lib/worker');
else require('./lib/master');