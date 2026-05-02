import 'react-native-reanimated';
import { registerRootComponent } from 'expo';

import App from './App';
import { applyWebViewportLock } from './utils/webViewport';

// Pin the web viewport before mount so iOS Safari does not auto-zoom into
// focused inputs (default Expo template has no ``maximum-scale``). No-op
// on iOS/Android native.
applyWebViewportLock();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
