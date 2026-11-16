const path = require('node:path');
const root = path.resolve(__dirname, '..');

module.exports = {
  appId: 'cn.ksanadu.qq-agent.desktop',
  productName: 'QQ Agent Desktop',
  artifactName: 'QQ-Agent-Desktop-${version}-Setup.${ext}',
  copyright: 'Copyright © 2026 QQ Agent contributors',
  directories: { app: __dirname, output: path.join(root, 'dist-desktop'), buildResources: path.join(__dirname, 'assets') },
  electronVersion: '33.4.11',
  electronDist: path.join(root, 'node_modules/electron/dist'),
  npmRebuild: false,
  asar: true,
  files: [
    'package.json', 'main.js', 'preload.cjs', 'gateway.js', 'preferences.js', 'window-policy.js', 'ui/**/*',
    { from: '../ui', to: 'legacy-ui', filter: ['**/*'] },
    'assets/icon.png', 'assets/icon.ico', 'assets/icon.svg',
    { from: '..', to: '.', filter: ['LICENSE'] },
    '!**/*.bak', '!**/*.tmp', '!node_modules{,/**/*}'
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(__dirname, 'assets/icon.ico') },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false, shortcutName: 'QQ Agent Desktop', runAfterFinish: false,
    installerLanguages: ['zh_CN', 'en_US'], language: '2052', packElevateHelper: false,
    installerIcon: path.join(__dirname, 'assets/icon.ico'), uninstallerIcon: path.join(__dirname, 'assets/icon.ico') },
  publish: null
};
