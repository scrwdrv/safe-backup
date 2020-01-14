
if (process.env.isWorker) import('./worker');
else import('./master');
process.on('SIGINT', () => { });