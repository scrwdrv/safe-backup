# safe-backup
A real-time backup CLI tool written in Typescript. safe-back helps you sync file/folder into a single password encrypted storage. Using technology of RSA & AES.


[![npm](https://img.shields.io/npm/v/safe-backup.svg)](https://npmjs.org/package/safe-backup)
[![downloads](https://img.shields.io/npm/dm/safe-backup.svg)](https://npmjs.org/package/safe-backup)

## Installation

```sh
npm i -g safe-backup
```

## Update
```sh
npm update -g safe-backup
```

## Usage 
```

safe-backup --input <inputPath1> [inputPath2 [inputPath3 ...]] 
            --output <outputPath1> [outputPath2 [outputPath3 ...]] 
            [--watch [interval]] [--ignore <regex> [regex [regex...]] 

safe-backup --decrypt <backupPath> [--password <password>]

safe-backup --help
safe-backup --version
safe-backup --config
safe-backup --build-config
safe-backup --reset-key
safe-backup --log

safe-backup --export-key [path]
safe-backup --import-key <path>


Options:

    -i --input          Absolute path(s) of folder/file to backup, separate by space.
    -o --output         Absolute path(s) of folder to store encrypted file, separate by space.
    -w --watch          Enable watch mode.
    -I --ignore         Add ignore rule with regex.  

    -d --decrypt        Absolute path of encrypted file to decrypt.
    -p --password       Password for decryption (not recommended to use password in command line).

    -h --help           Show this screen.
    -v --version        Show version.
    -c --config         Show current configuration.
    -b --build-config   Start building configurations.
    --reset-key         Delete both public & private key, 
                        previously encrypted files can still decrypt by original password.
    -l --log            Show location of log files.

    --export-key        Export current key.
    --import-key        Import previously generated key.

```

## Contributing

1. [Fork this repo](https://github.com/scrwdrv/safe-backup/fork)
2. Create your feature branch (`git checkout -b feature/fooBar`)
3. Commit your changes (`git commit -am 'Add some fooBar'`)
4. Push to the branch (`git push origin feature/fooBar`)
5. Create a new Pull Request