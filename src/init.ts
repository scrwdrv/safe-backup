import cliParmas from 'cli-params';

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



export default args;


