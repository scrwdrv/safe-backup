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
            currentStream.push(null);
            exec = () => this.input.emit('finish');
        };
        let bytesLeft = 0, indexHeader = null, previousBuffer, currentStream = null, exec;
        const parseChunk = (c, next) => {
            if (indexHeader) {
                appendBuffer(c);
                if (previousBuffer.length >= indexHeader.nameLength) {
                    const iHeader = indexHeader, nameLength = iHeader.nameLength, name = previousBuffer.slice(0, nameLength).toString();
                    exec = () => {
                        const header = {
                            name: name,
                            size: iHeader.size,
                            mtime: iHeader.mtime,
                            type: iHeader.type
                        }, nextChunk = previousBuffer.slice(nameLength);
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
                    indexHeader = null;
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
                    const indexOfLastComma = (function findComma(offset = bytesLeft, found = 0) {
                        const index = previousBuffer.indexOf(',', offset + 1);
                        if (index > -1) {
                            found++;
                            if (found === 4)
                                return index;
                            return findComma(index, found);
                        }
                        else
                            return false;
                    })();
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
        function appendBuffer(c) {
            if (previousBuffer)
                previousBuffer = Buffer.concat([previousBuffer, c]);
            else
                previousBuffer = c;
        }
        function parseIndex(c) {
            let index = 0, arr = [], type;
            while (index !== -1 && arr.length < 4) {
                const i = c.indexOf(',', index);
                arr.push(c.slice(index, i === -1 ? undefined : i).toString());
                index = i + 1;
            }
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
        this.output.push(Buffer.from(type + ',' + mtime + ',' + header.name.length.toString() + ',' + header.size + ',' + header.name));
    }
}
exports.Pack = Pack;
