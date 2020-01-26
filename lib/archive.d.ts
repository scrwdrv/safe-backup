/// <reference types="node" />
import * as stream from 'stream';
interface Header {
    name: string;
    size: number;
    mtime: number;
    type: 'file' | 'directory';
}
declare class ExtractStream extends stream.Readable {
    constructor();
    skip(cb: () => void): void;
}
export declare class Extract {
    input: stream.Writable;
    private entryHandler;
    constructor();
    onEntry(cb: (header: Header, stream: ExtractStream, next: (err?: any) => void) => void): void;
}
export declare class Pack {
    output: stream.Readable;
    constructor();
    finalize(): void;
    entry(header: Header, next: (err?: Error) => void): stream.Writable;
    writeHeader(header: Header): void;
}
export {};
