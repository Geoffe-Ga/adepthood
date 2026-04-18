import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// expo-secure-store only allows alphanumerics plus `.`, `-`, `_` in keys,
// so we cannot use the `@adepthood/...` namespace prefix here.
const TOKEN_KEY = 'adepthood_auth_token';

// ``expo-secure-store`` v55 has no web implementation — its web module is
// literally ``export default {}``, so calling ``SecureStore.setItemAsync``
// throws ``TypeError: … is not a function`` and every auth attempt in the
// Expo Web build fails with the generic signup fallback copy. On web we
// fall back to ``AsyncStorage`` (which resolves to ``localStorage``) so
// the flow works end-to-end. Native keeps using Keychain/Keystore.
const isWeb = Platform.OS === 'web';

export async function saveToken(token: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  if (isWeb) return AsyncStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  if (isWeb) {
    await AsyncStorage.removeItem(TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
