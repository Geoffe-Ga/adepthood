declare module 'react-test-renderer' {
  export interface ReactTestInstance {
    [key: string]: any;
  }
  const renderer: any;
  export default renderer;
  export const act: any;
}
