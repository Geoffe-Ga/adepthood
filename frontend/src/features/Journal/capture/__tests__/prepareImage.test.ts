/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ImageManipulator } from 'expo-image-manipulator';
import type { ImageManipulatorContext, ImageRef, SaveOptions } from 'expo-image-manipulator';

import {
  MAX_TRANSCRIBE_IMAGE_BYTES,
  TRANSCRIBE_JPEG_QUALITY,
  TRANSCRIBE_LONG_EDGE_PX,
  preparePageForTranscription,
} from '../prepareImage';

const manipulate = jest.mocked(ImageManipulator.manipulate);

const SOURCE_URI = 'file:///cache/ImagePicker/source-page.jpg';
const SAVED_URI = 'file:///cache/manipulated/prepared-page.jpg';
// 'QUJDRA==' decodes to the four bytes of 'ABCD'.
const SAVED_BASE64 = 'QUJDRA==';

interface SavedResult {
  uri: string;
  width: number;
  height: number;
  base64?: string;
}

interface Chain {
  resize: jest.MockedFunction<
    (_size: { width?: number; height?: number }) => ImageManipulatorContext
  >;
  renderAsync: jest.MockedFunction<() => Promise<ImageRef>>;
  saveAsync: jest.MockedFunction<(_options?: SaveOptions) => Promise<SavedResult>>;
}

// Builds the mocked manipulate -> context -> render -> save chain for one
// rendered image of the given (already EXIF-normalized) dimensions.
function mockManipulationChain({
  width,
  height,
  savedUri = SAVED_URI,
  savedBase64 = SAVED_BASE64,
}: {
  width: number;
  height: number;
  savedUri?: string;
  savedBase64?: string;
}): Chain {
  const saveAsync = jest.fn() as Chain['saveAsync'];
  saveAsync.mockResolvedValue({ uri: savedUri, width, height, base64: savedBase64 });
  const image = { width, height, saveAsync } as unknown as ImageRef;
  const renderAsync = jest.fn() as Chain['renderAsync'];
  renderAsync.mockResolvedValue(image);
  const resize = jest.fn() as Chain['resize'];
  const context = { resize, renderAsync } as unknown as ImageManipulatorContext;
  resize.mockReturnValue(context);
  manipulate.mockReturnValue(context);
  return { resize, renderAsync, saveAsync };
}

beforeEach(() => {
  manipulate.mockReset();
});

describe('preparePageForTranscription — constants', () => {
  it('pins the exact transcription sizing constants', () => {
    expect(TRANSCRIBE_LONG_EDGE_PX).toBe(1568);
    expect(TRANSCRIBE_JPEG_QUALITY).toBe(0.8);
    expect(MAX_TRANSCRIBE_IMAGE_BYTES).toBe(5242880);
  });
});

describe('preparePageForTranscription — downscaling', () => {
  it('loads the manipulation context from the given source uri', async () => {
    mockManipulationChain({ width: 1000, height: 800 });
    await preparePageForTranscription(SOURCE_URI);
    expect(manipulate).toHaveBeenCalledTimes(1);
    expect(manipulate).toHaveBeenCalledWith(SOURCE_URI);
  });

  it('resizes a landscape page over the long edge down to width 1568, preserving ratio', async () => {
    const { resize } = mockManipulationChain({ width: 4000, height: 3000 });
    await preparePageForTranscription(SOURCE_URI);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ width: TRANSCRIBE_LONG_EDGE_PX });
  });

  it('resizes a portrait page over the long edge down to height 1568, preserving ratio', async () => {
    const { resize } = mockManipulationChain({ width: 3000, height: 4000 });
    await preparePageForTranscription(SOURCE_URI);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ height: TRANSCRIBE_LONG_EDGE_PX });
  });

  it('never upscales a page already within the long edge, yet still re-saves it', async () => {
    const { resize, saveAsync } = mockManipulationChain({ width: 1000, height: 800 });
    await preparePageForTranscription(SOURCE_URI);
    expect(resize).not.toHaveBeenCalled();
    expect(saveAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves a page whose long edge is exactly 1568 unresized', async () => {
    const { resize } = mockManipulationChain({ width: 1568, height: 1200 });
    await preparePageForTranscription(SOURCE_URI);
    expect(resize).not.toHaveBeenCalled();
  });

  it('resizes a page one pixel over the long edge', async () => {
    const { resize } = mockManipulationChain({ width: 1569, height: 1200 });
    await preparePageForTranscription(SOURCE_URI);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ width: TRANSCRIBE_LONG_EDGE_PX });
  });

  it('chooses the resize axis from the rendered (EXIF-normalized) dimensions', async () => {
    // A phone photo is often stored landscape with a rotation flag; the
    // rendered image reports the upright portrait dimensions, and the axis
    // choice must follow those, not any stored-file metadata.
    const { resize } = mockManipulationChain({ width: 2448, height: 3264 });
    await preparePageForTranscription('file:///cache/ImagePicker/rotated-camera-page.jpg');
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ height: TRANSCRIBE_LONG_EDGE_PX });
  });
});

describe('preparePageForTranscription — save and result', () => {
  it('saves as jpeg at 0.8 compression with an inline base64 payload', async () => {
    const { saveAsync } = mockManipulationChain({ width: 4000, height: 3000 });
    await preparePageForTranscription(SOURCE_URI);
    expect(saveAsync).toHaveBeenCalledTimes(1);
    expect(saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.8, base64: true });
  });

  it('returns the saved base64, jpeg media type, decoded byte length, and output uri', async () => {
    mockManipulationChain({ width: 1200, height: 900 });
    const prepared = await preparePageForTranscription(SOURCE_URI);
    expect(prepared).toEqual({
      base64: SAVED_BASE64,
      mediaType: 'image/jpeg',
      byteLength: 4,
      uri: SAVED_URI,
    });
  });

  it.each([
    ['QUJD', 3],
    ['QUJDREU=', 5],
    ['QUJDRA==', 4],
  ])('derives byteLength from the decoded size of base64 %s', async (savedBase64, expected) => {
    mockManipulationChain({ width: 1000, height: 800, savedBase64 });
    const prepared = await preparePageForTranscription(SOURCE_URI);
    expect(prepared.byteLength).toBe(expected);
  });
});
