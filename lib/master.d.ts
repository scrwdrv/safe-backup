declare global {
    interface Config {
        input: string[];
        output: string[];
        watch: number;
        ignore: string[];
        publicKey: string;
    }
    interface BackupOptions {
        input: string;
        output: string[];
        account: string;
        publicKey: string;
        encryptedPrivateKey: string;
        ignore: string[];
    }
    interface DecryptOptions {
        input: string;
        passwordHash: string;
    }
}
export {};
