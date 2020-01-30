# Safe Backup
> A real-time backup CLI tool written in Typescript. Safe Backup helps you sync file/folder into a single password encrypted storage. Using technology of RSA & AES.

[![npm](https://img.shields.io/npm/v/safe-backup.svg)](https://npmjs.org/package/safe-backup)
[![downloads](https://img.shields.io/npm/dm/safe-backup.svg)](https://npmjs.org/package/safe-backup)
[![travis](https://img.shields.io/travis/scrwdrv/safe-backup/master.svg)](https://travis-ci.org/scrwdrv/safe-backup)


![safe-backup-preview](https://github.com/scrwdrv/safe-backup/blob/master/assets/preview.png?raw=true)

## Features

- Backup your sensitive files in the safest way possible
  - Use `AES-256-CTR` for encryption, and `RSA-4096` for storing cipher key
  - Password is salted and hashed, never store/use a plain password
  - No way to decrypt in hundreds of years without having the exact password
  - Even hacker somehow obtained `key.safe` file with password hash inside (set `savePassword` to `false` then no one can ever crack it), there is no way to crack it without knowing the source code

- Easy & powerful at the same time
  - Support both file and folder
  - Exclude files and folders with regular expression
  - Real-time monitoring files changes and synchronize modified ones
  - Pack complicate directories into a single file, easier to transport
  - Cross platform friendly, tested on Linux, Windows & MacOS
  - Original config & key pair is NOT needed for decryption, unpack & decrypt your files on any devices
  - [Config builder](#config-builder) to spare you from annoying parameters

- Highly optimized on speed
  - Created a whole new archive format just for performance
  - Pipe unchanged files directly without re-encrypting when `savePassword` is set to `true`
  - Runs in [cluster](https://nodejs.org/api/cluster.html), unleash the full power of multi-core processor
    - 20% ~ 45% faster when dealing with multiple inputs

## Table of Contents

- [Installation](#installation)
  - [Install from npm](#install-from-npm-node-package-manager)
    - [Requirements](#requirements)
    - [Install Node.js LTS](#install-nodejs-lts)
        - [Already installed node/nvm](#already-installed-nodenvm)
        - [Start from scratch](#start-from-scratch)
  - [Download Prebuilt Binary](#download-prebuilt-binary)
- [Update](#update)
- [Usage](#usage)
  - [Configuration & Config Builder](#configuration--config-builder)
    - [Config builder](#config-builder)
    - [Configuration file](#configuration-file)
    - [Path to `config.json`](#path-to-configjson)
  - [Backup](#backup)
    - [Backup options](#backup-options)
    - [Backup examples](#backup-examples)
  - [Unpack & Decrypt](#unpack--decrypt)
    - [Decrypt options](#decrypt-options)
    - [Decrypt examples](#decrypt-examples)
  - [Misc](#misc)
    - [Misc options](#misc-options)
    - [Misc examples](#misc-examples)
- [Changelog](#changelog)
- [Todo](#todo)
- [Meta](#meta)
- [Contributing](#contributing)

## Installation

### Install from [npm](https://www.npmjs.com/package/safe-backup) (node package manager)

*You can skip this section to [Install Safe Backup](#install-safe-backup) if you're quite familiar with Node.*

- ### Requirements
    - Node.js v11.6.0+
    - npm (included by Node.js nowadays)
    - nvm (optional)

1. ### Install Node.js LTS

    #### Already installed node/nvm

    If you have installed Node.js before, you can use `node -v` to check the version you have installed, if is outdated: 
    ```sh
    nvm list
    #    12.10.0
    #  * 8.9.4
    #    8.2.1

    nvm use 12.10.0
    ```
    If you don't have v11.6.0+ installed on nvm:
    ```sh
    nvm install --lts
    nvm use --lts
    ```

    #### Start from scratch

    For those who have never deal with Node.js before, it is recommended to use [nvm](https://github.com/nvm-sh/nvm) (node version manager) so you can have multiple versions of Node and switch to another version as you like. It's available on both Linux & Windows.

    - For Linux (Ubuntu, Debian, RedHat, etc.)

        Install cURL to download installation script
        ```
        sudo apt update
        sudo apt install curl
        ``` 
        Install nvm & node (default is LTS)
        ```sh
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.2/install.sh | bash
        nvm install node
        node -v 
        # 12.14.1
        ```
        If you ran into some errors like `Command 'node' not found, ...`, try to reload your path variable:
        ```sh
        source ~/.bashrc
        ```
    - For Windows

        Use [nvm-windows](https://github.com/coreybutler/nvm-windows) created by coreybutler instead, a quick setup executable could be found at [release page](https://github.com/coreybutler/nvm-windows/releases). 
        
        After you have installed nvm and added to $PATH (which should be done automatically, **restart terminal** might be required):
        ```sh
        nvm install node
        node -v 
        # 12.14.1
        ```

2. ### Install Safe Backup
    Install safe-backup globally is recommended, so you can use it directly by calling `safe-backup` at the terminal.
    ```sh
    npm i -g safe-backup
    ```

### Download Prebuilt Binary

This way is recommended for people just want to use it on the fly. Download and execute, that's how simple it is. You don't have to install or build any environment for safe-backup to run, a full Node.js binary based on your operating platform is built-in.

Executable binary is built by [pkg](https://github.com/zeit/pkg), which is a great tool to pack your Node.js app into a single executable and run on devices without Node.js installed.

Currently support Linux, Windows & MacOS, all have been tested. To download latest safe-backup binary and check out release notes, please head to [release page](https://github.com/scrwdrv/safe-backup/releases).


## Update
```sh
npm update -g safe-backup
```
Update safe-backup by `npm update` is only available for those who install with npm. For binary users, download new version of binary at [release page](https://github.com/scrwdrv/safe-backup/releases) and replace it manually. You don't need to worry about losing your configuration or have your password reset, those files are saved at different directory based on your OS.


## Usage
### Configuration & Config Builder

- #### Config builder

    If safe-backup is ran without parameters, it will try to recover configuration from last usage If no previous configuration is found, config builder will help you to build one without having to deal with these annoying parameters!

- #### Configuration file 

    `config.json` will be generated automatically at system AppData path based on your OS when initialized. So the next time you open safe-backup there is no need to reconfigure the whole thing again. 

    If you wish to update configuration, all you have to do is use your desired [backup parameters](#backup) in command line again or use [config builder](#misc) and it will overwrite the old configuration. You can even manually edit `config.json` if you know what you're doing.

    Here is an example of how configuration file looks like:
    
    ```json
    {
        "input": [
            "C:\\Users\\Bob\\Pictures",
            "C:\\Users\\Bob\\Videos"
        ],
        "output": [
            "D:\\Backup",
            "F:\\Backup" 
        ],
        "watch": 120,
        "savePassword": false,
        "ignore": [
            "/^2018-/",
            "/.+\\.tif$/i"
        ]
    }
    ```

- #### Path to `config.json`
    - Linux: `/home/username/.config/safe-backup/config.json`
    - Windows: `C:\Users\username\AppData\Roaming\safe-backup\config.json`
    - MacOS: `/Users/username/Library/Application Support/safe-backup/config.json`

### Backup

  - #### Backup options:
 
    | Parameter     |Alias|Optional | Value                | Description                                        |
    |:--------------|:---:|:-------:|:--------------------:|:--------------------------------------------------:|
    |--input        | -i  | `false` |`string` \| `strings` | Absolute paths of folders/files to backup,<br/> paths start with `*` will not be encrypted or packed|
    |--output       | -o  | `false` |`string` \| `strings` | Absolute paths of folders to store backup files    |
    |--watch        | -w  | `true`  |`number` \| `null`    | Enable watch mode. Default check interval is `60`  |
    |--ignore       | -I  | `true`  |`string` \| `strings` | Add ignore rules with regex                        |
    |--save-password| -s  | `true`  |`boolean`             | Save password to the system. Default is `true`     |


  - #### Backup examples

    Backup one directory to another in watch mode (check every 120 secs) and disable save password:
    ```sh
    safe-backup -i "C:\Users\Bob\Pictures" -o "D:\Backup" -w 120 -s false
    ```
    Mutiple input & output:
    ```sh
    safe-backup -i "C:\Users\Bob\Pictures" "C:\Users\Bob\Videos" -o "D:\Backup" "F:\Backup" 
    ```
    Backup without encryption or packing:
    ```sh
    safe-backup -i "*C:\Users\Bob\Pictures" -o "D:\Backup"
    ```
    Path contains spaces:
    ```sh
    safe-backup -i "C:\Users\Bob\Hello World.txt" -o "D:\Backup Destination"
    ```
    Exclude path with [regular expression](https://en.wikipedia.org/wiki/Regular_expression):
    ```sh
    safe-backup -i "C:\Users\Bob\Pictures" -o "D:\Backup" -I "/^2018-/" "/.+\.tif$/i"
    ```

### Unpack & Decrypt

  If `--password` is not specified, it will prompt for password (which is recommended, you should never use password in command line).

  - #### Decrypt options
 
    | Parameter     |Alias|Optional | Value                | Description                                        |
    |:--------------|:---:|:-------:|:--------------------:|:--------------------------------------------------:|
    |--decrypt      | -d  | `false` |`string` \| `strings` | Paths of encrypted files to decrypt               |
    |--password     | -p  | `true`  |`string`              | Password for decryption (not recommended)          |

  - #### Decrypt examples

    Decrypt a previous encrypted file:
    ```sh
    safe-backup -d "D:\Backup\C-Users-Bob-Pictures"
    ```
    Decrypt mutiple encrypted files:
    ```sh
    safe-backup -d "D:\Backup\C-Users-Bob-Pictures" "C:\Users\Bob\Videos"
    ```
    Decrypt a previous encrypted file with password in command line (not recommended):
    ```sh
    safe-backup -d "D:\Backup\C-Users-Bob-Pictures" -p "123"
    ```
### Misc

  - #### Misc options

    | Parameter     |Alias| Value             | Description                                        |
    |---------------|:---:|:-----------------:|:--------------------------------------------------:|
    |--help         | -h  |`null`             | Print out usage guide in command line              |
    |--version      | -v  |`null`             | Show version                                       |
    |--config       | -c  |`null`             | Show current configuration                         |
    |--build-config | -b  |`null`             | Start config builder                               |
    |--reset-config |`n/a`|`null`             | Delete configuration file                          |
    |--reset-key    |`n/a`|`null`             | Delete both public & private key                   |
    |--log          | -l  |`null`             | Show location of log files                         |
    |--export-config|`n/a`|`null` \| `string` | Export current configuration                       |
    |--import-config|`n/a`|`string`           | Import previously generated configuration          |
    |--export-key   |`n/a`|`null` \| `string` | Export current key                                 |
    |--import-key   |`n/a`|`string`           | Import previously generated key                    |
    |--test         |`n/a`|`null` \| `number` | Run `n` times of backup in a row, default is `10`  |

  - #### Misc examples

    Export current configuration to current cwd (current working directory):
    ```sh
    safe-backup --export-config
    ```
    Import key from previously generated `key.safe` file:
    ```sh
    safe-backup --import-key "./keys/key.safe"
    ```
    Run 10 times of backup for performance testing:
    ```sh
    safe-backup --test 10
    ```

## Changelog
- v1.4.3
  - v1.1.1 release
- v1.4.2
  - Add `test` mode to run `n` times of backup in a row
  - Warm up each worker when they were forked, improve first time performance
- v1.4.1
  - Add plain backup (no packing and encryption)
  - [bua](https://github.com/scrwdrv/bua) bug fixed
  - No longer change mtime & atime of directories
  - v1.1 release
- v1.3.18
  - `archive` is now a new module named [bua](https://github.com/scrwdrv/bua)
  - Restore original stats (mtime, permission, etc.) when unpacking
  - **NOTICE:** Added `mode` to bua header, not compatible with encrypted files generate by previous version
- v1.3.17
  - Allow multiple files to decrypt at once
  - Remove abs path check on decryption since it's meaningless
  - Add backup rate to logging
- v1.3.16
  - Add basic documentation
  - Print version & github repo at startup
  - v1.0.1 release
- v1.3.12
  - Encrypt password hash twice
  - Little improvements on archive
  - Better config builder (add `ignore` & `savePassword`)
  - v1.0 release
- v1.3.7
  - Use `node-watch` to add recursive folder watch on Linux 
  - Change logger to [colorful-log](https://github.com/scrwdrv/colorful-log) to prevent ipc problem
- v1.2.6
  - Add update check and notification
  - Migrate from `keytar` to `fs` for key storage
  - It is now optional to save password
- v1.2.2
  - Fix `bytesLength !== length`
- v1.2.1
  - Migrate from Tar to custom archive format (much faster)
- v1.2.0
  - Store key to appdata
  - Add export & import key
  - Pipe unchanged files to new pack without re-encrypting
- v1.1.4
  - Decrypting no longer need original private key
- v1.1.0
  - Refactor encrypt system
  - Introduce asymmetric cryptography to store password more wisely
- v1.0.8
  - Basic functions have initially completed
  - v0.1.0-alpha release
- v1.0.0
  - Work in progress
  - Add [cliParams](https://github.com/scrwdrv/cli-params) to parse arguments


## Todo
- [x] Plain backup (no packing and encryption)
- [ ] Benchmark
- [x] Allow multiple files to decrypt at once
- [x] Unpacked files to have original stats (mtime, permission, etc.)
- [ ] GUI (not very useful to me though)

## Meta

scrwdrv @ scrwdrv.tech@gmail.com

Distributed under the MIT license. See [`LICENSE`](https://github.com/scrwdrv/safe-backup/blob/master/LICENSE) for more information.


## Contributing

1. [Fork this repo](https://github.com/scrwdrv/safe-backup/fork)
2. Create your feature branch (`git checkout -b feature/fooBar`)
3. Commit your changes (`git commit -am 'Add some fooBar'`)
4. Push to the branch (`git push origin feature/fooBar`)
5. Create a new Pull Request