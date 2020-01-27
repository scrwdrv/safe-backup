declare global {
    interface Config {
        input: string[];
        output: string[];
        watch: number;
        ignore: string[];
        publicKey: string;
        savePassword: boolean;
    }
    interface BackupOptions {
        input: string;
        output: string[];
        passwordHash?: string;
        publicKey: string;
        encryptedPrivateKey: string;
        ignore: string[];
    }
    interface PlainBackupOptions {
        input: string;
        output: string[];
        ignore: string[];
    }
    interface DecryptOptions {
        input: string;
        passwordHash: string;
    }
    interface Keys {
        public: string;
        encryptedPrivate: string;
        passwordHash?: string;
    }
}
export {};
