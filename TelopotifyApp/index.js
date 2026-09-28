/**
 * @format
 */

import { AppRegistry, Platform } from 'react-native';
import App from './App';
import IOSApp from './src/ios/IOSApp';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => Platform.OS === 'ios' ? IOSApp : App);
