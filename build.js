const nexe = require('nexe'),
    fs = require('fs'),
    version = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;

nexe.compile({
    input: './index.js',
    name: 'safe-backup',
    build: true,
    ico: './assets/icon.ico',
    rc: {
        CompanyName: 'scrwdrv.tech',
        ProductName: 'Safe Backup',
        FileDescription: 'A CLI tool that helps you backup file or folder into a single password encrypted file. Using technology of Tar & AES.',
        ProductVersion: version,
        FileVersion: version,
        OriginalFilename: 'safe-backup.exe',
        InternalName: 'safe-backup',
        LegalCopyright: 'Copyright scrwdrv and contributors. MIT license.'
    }
});