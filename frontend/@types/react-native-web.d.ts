import 'react-native';

/**
 * Type augmentation for react-native-web hover props.
 *
 * React Native Web adds mouse event handlers (onMouseEnter, onMouseLeave)
 * to View and Touchable components. These props are not part of the
 * standard React Native type definitions. This declaration extends them
 * so that web-specific hover handlers type-check correctly.
 */
declare module 'react-native' {
  interface ViewProps {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }

  interface TouchableOpacityProps {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }
}
