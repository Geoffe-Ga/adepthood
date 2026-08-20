import 'react-native-reanimated';
import { registerRootComponent } from 'expo';

import App from './App';
import { initErrorMonitoring } from './observability/sentry';
import { applyWebViewportLock } from './utils/webViewport';

// Before the first component mounts, so a crash during the very first render
// still has somewhere to go. Emits exactly one line and never throws: an
// unconfigured build runs normally and reports crashes to the console only.
initErrorMonitoring();

applyWebViewportLock();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
