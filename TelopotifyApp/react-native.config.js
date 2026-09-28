// React Native CLI 20 does not discover the Windows commands automatically.
// Loading them on macOS also loads Windows-only PowerShell tools during pod install.
module.exports = process.platform === 'win32'
  ? require('react-native-windows/react-native.config.js')
  : {};
