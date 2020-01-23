"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const stream = require("stream");
class ExtractStream extends stream.Readable {
    constructor() {
        super();
    }
    skip(cb) {
        this.on('end', cb);
        this.resume();
    }
}
class Extract {
    constructor() {
        this.input = new stream.Writable({});
        this.input._write = (chunk, encoding, next) => parseChunk(chunk, next);
        this.input._final = () => {
            exec = () => this.input.emit('finish');
            currentStream.push(null);
        };
        let bytesLeft = 0, indexHeader = null, previousBuffer, currentStream = null, exec;
        const parseChunk = (c, next) => {
            if (indexHeader) {
                appendBuffer(c);
                if (previousBuffer.length >= indexHeader.nameLength) {
                    const header = {
                        name: previousBuffer.slice(0, indexHeader.nameLength).toString(),
                        size: indexHeader.size,
                        mtime: indexHeader.mtime,
                        type: indexHeader.type
                    }, nextChunk = previousBuffer.slice(indexHeader.nameLength);
                    indexHeader = null;
                    exec = () => {
                        currentStream = new ExtractStream();
                        currentStream._read = () => { };
                        this.entryHandler(header, currentStream, (err) => {
                            currentStream = null;
                            if (err)
                                return this.input.destroy(err);
                            exec();
                        });
                        bytesLeft = header.size;
                        previousBuffer = null;
                        if (nextChunk.length)
                            parseChunk(nextChunk, next);
                        else
                            next();
                    };
                    if (currentStream)
                        currentStream.push(null);
                    else
                        exec();
                }
                else
                    next();
            }
            else {
                const cL = c.length, diff = bytesLeft - cL;
                if (diff < 0) {
                    appendBuffer(c);
                    const indexOfLastComma = findComma();
                    if (indexOfLastComma !== false) {
                        indexHeader = parseIndex(previousBuffer.slice(bytesLeft, indexOfLastComma));
                        if (currentStream && bytesLeft)
                            currentStream.push(previousBuffer.slice(0, bytesLeft));
                        const nextChunk = previousBuffer.slice(indexOfLastComma + 1);
                        previousBuffer = null;
                        if (nextChunk.length)
                            parseChunk(nextChunk, next);
                        else
                            next();
                    }
                    else
                        next();
                }
                else {
                    bytesLeft = diff;
                    if (currentStream)
                        currentStream.push(c);
                    next();
                }
            }
        };
        function findComma(offset = bytesLeft, found = 0) {
            const index = previousBuffer.indexOf(',', offset + 1);
            if (index > -1) {
                found++;
                if (found === 4)
                    return index;
                return findComma(index, found);
            }
            else
                return false;
        }
        function appendBuffer(c) {
            if (previousBuffer)
                previousBuffer = Buffer.concat([previousBuffer, c]);
            else
                previousBuffer = c;
        }
        function parseIndex(c) {
            let arr = c.toString().split(','), type;
            switch (arr[0]) {
                case '0':
                    type = 'file';
                    break;
                case '1':
                    type = 'directory';
                    break;
                default:
                    throw new Error(`Unknown type`);
            }
            let header = {
                nameLength: parseInt(arr[2]),
                size: parseInt(arr[3]),
                mtime: parseInt(arr[1]),
                type: type
            };
            if (header.nameLength === NaN)
                throw new Error(`Invalid nameLength`);
            if (header.size === NaN)
                throw new Error(`Invalid size`);
            if (header.mtime === NaN)
                throw new Error(`Invalid mtime`);
            return header;
        }
    }
    onEntry(cb) {
        this.entryHandler = cb;
    }
}
exports.Extract = Extract;
class Pack {
    constructor() {
        this.output = new stream.Readable();
        this.output._read = () => { };
    }
    finalize() {
        this.output.push(null);
    }
    entry(header, next) {
        this.writeHeader(header);
        const ws = new stream.Writable().on('finish', next);
        ws._write = (chunk, encoding, next) => {
            this.output.push(chunk);
            next();
        };
        return ws;
    }
    writeHeader(header) {
        const mtime = header.mtime.toString(), type = header.type === 'file' ? 0 : 1;
        this.output.push(Buffer.from(type + ',' + mtime + ',' + Buffer.byteLength(header.name).toString() + ',' + header.size + ',' + header.name));
    }
}
exports.Pack = Pack;
