import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Register for push notifications and return the Expo push token if available.
 * Skips token retrieval on web where push is unsupported.
 */
export const registerForPushNotificationsAsync = async (): Promise<string | undefined> => {
  try {
    if (Platform.OS === 'web') {
      return undefined;
    }
    if (!Notifications.getPermissionsAsync || !Notifications.requestPermissionsAsync) {
      return undefined;
    }
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return undefined;
    }
    if (!Notifications.getExpoPushTokenAsync) {
      return undefined;
    }
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    return token;
  } catch (error) {
    console.warn('Failed to get push token:', error);
    return undefined;
  }
};
