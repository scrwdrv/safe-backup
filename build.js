const { compile } = require('nexe'),
    fs = require('fs'),
    version = JSON.parse(fs.readFileSync('./package.json', 'utf8')).version;

compile({
    input: './index.js',
    target: 'win32-x86-10.13.0',
    name: 'safe-backup',
    build: true,
    ico: './icon.ico',
    rc: {
        CompanyName: 'scrwdrv.tech',
        ProductName: 'Safe Backup',
        FileDescription: 'A CLI tool that helps you backup file or folder into a single password encrypted file. Using technology of Tar & AES.',
        ProductVersion: version,
        FileVersion: version,
        OriginalFilename: 'safe-backup.exe',
        InternalName: 'safe-backup',
        LegalCopyright: 'Copyright scrwdrv contributors. MIT license.'
    }
}).then(() => {
    console.log('success');
});