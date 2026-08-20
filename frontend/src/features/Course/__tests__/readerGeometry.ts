/**
 * Reader geometry helpers shared by the Course reader suites.
 *
 * The reader keeps its chapter controls out of the way until the end of the
 * essay is in view, and it learns where that is from three platform callbacks
 * that never fire under the test renderer: the ScrollView's layout, its content
 * size, and its scroll offset. Any test that exercises the controls therefore
 * has to arrive at the bottom the way a reader does, and these helpers are that
 * journey — kept in one place so the four suites that need it cannot drift.
 */
import { fireEvent, type render } from '@testing-library/react-native';

export const READER_WIDTH = 390;
export const READER_VIEWPORT_HEIGHT = 600;
/** Tall enough to need scrolling; the essay's end starts out well off-screen. */
export const LONG_ESSAY_HEIGHT = 2400;
/** Shorter than the viewport: a chapter that never scrolls at all. */
export const SHORT_ESSAY_HEIGHT = 400;

type ScrollTarget = Parameters<typeof fireEvent.scroll>[0];
type Rendered = ReturnType<typeof render>;

/** Report the reader's geometry the way the platform does on first layout. */
export const measureReader = (scrollView: ScrollTarget, contentHeight: number): void => {
  fireEvent(scrollView, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: READER_WIDTH, height: READER_VIEWPORT_HEIGHT } },
  });
  fireEvent(scrollView, 'contentSizeChange', READER_WIDTH, contentHeight);
};

/** Measure a long essay and scroll it to the end, revealing the controls. */
export const revealControls = (scrollView: ScrollTarget): void => {
  measureReader(scrollView, LONG_ESSAY_HEIGHT);
  fireEvent.scroll(scrollView, {
    nativeEvent: { contentOffset: { y: LONG_ESSAY_HEIGHT - READER_VIEWPORT_HEIGHT } },
  });
};

/** Await the loaded reader, then read it to the end. */
export const readToTheEnd = async (
  findByTestId: Rendered['findByTestId'],
): Promise<ScrollTarget> => {
  const scrollView = await findByTestId('reader-markdown');
  revealControls(scrollView);
  return scrollView;
};
