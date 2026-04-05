declare module 'expo-av' {
  interface SoundObject {
    playAsync(): Promise<void>;
    unloadAsync(): Promise<void>;
  }

  interface CreateAsyncResult {
    sound: SoundObject;
  }

  interface SoundStatic {
    createAsync(_source: number | { uri: string }): Promise<CreateAsyncResult>;
  }

  export const Audio: {
    Sound: SoundStatic;
  };
}
