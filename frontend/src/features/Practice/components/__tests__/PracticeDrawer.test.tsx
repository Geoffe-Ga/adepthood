// RED: PracticeDrawer does not exist yet -- this import fails until the
// implementation-specialist adds the component. Specifies the Practice-tab
// header-drawer body: catalog/customize/details/create rows for the active
// state, and the pared-down browse/create pair for the no-active-practice
// state.
import { describe, expect, it, jest, afterEach } from '@jest/globals';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// eslint-disable-next-line import/order
const { fireEvent, render } = require('@testing-library/react-native');
const PracticeDrawer = require('../PracticeDrawer').default;

const noop = (..._args: unknown[]): void => {};

const activeProps = {
  hasActivePractice: true,
  practiceId: 7,
  onCustomize: noop,
  onBrowseCatalog: noop,
  sessionActive: false,
  onClose: noop,
};

const emptyProps = {
  hasActivePractice: false,
  onCustomize: noop,
  onBrowseCatalog: noop,
  sessionActive: false,
  onClose: noop,
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('PracticeDrawer active state', () => {
  it('renders the five active-state rows in order', () => {
    const { getAllByRole } = render(<PracticeDrawer {...activeProps} />);
    const rows = getAllByRole('button');
    const labels = rows.map(
      (r: { props: { accessibilityLabel: string } }) => r.props.accessibilityLabel,
    );
    expect(labels).toEqual([
      'Change practice',
      'Browse all practices',
      'Customize this practice',
      'Practice details',
      'Create a practice',
    ]);
  });

  it('pressing "Change practice" flips to the embedded catalog and closes the drawer', () => {
    const onBrowseCatalog = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = render(
      <PracticeDrawer {...activeProps} onBrowseCatalog={onBrowseCatalog} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('practice-drawer-change'));
    expect(onBrowseCatalog).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('pressing "Browse all practices" flips to the embedded catalog and closes the drawer', () => {
    const onBrowseCatalog = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = render(
      <PracticeDrawer {...activeProps} onBrowseCatalog={onBrowseCatalog} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('practice-drawer-browse'));
    expect(onBrowseCatalog).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('pressing "Customize this practice" calls onCustomize and closes the drawer', () => {
    const onCustomize = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = render(
      <PracticeDrawer {...activeProps} onCustomize={onCustomize} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('practice-drawer-customize'));
    expect(onCustomize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('pressing "Practice details" navigates to PracticeDetail with the practiceId and closes the drawer', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <PracticeDrawer {...activeProps} practiceId={42} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('practice-drawer-details'));
    expect(mockNavigate).toHaveBeenCalledWith('PracticeDetail', { practiceId: 42 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing "Create a practice" navigates to CreatePractice and closes the drawer', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<PracticeDrawer {...activeProps} onClose={onClose} />);
    fireEvent.press(getByTestId('practice-drawer-create'));
    expect(mockNavigate).toHaveBeenCalledWith('CreatePractice');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits "Practice details" when practiceId is undefined', () => {
    const { queryByTestId } = render(<PracticeDrawer {...activeProps} practiceId={undefined} />);
    expect(queryByTestId('practice-drawer-details')).toBeNull();
  });

  it('gives each row an accessibility label matching its visible text', () => {
    const { getByLabelText, getByText } = render(<PracticeDrawer {...activeProps} />);
    expect(getByLabelText('Customize this practice')).toBeTruthy();
    expect(getByText('Customize this practice')).toBeTruthy();
  });

  it('withholds the in-place catalog rows while a session is active', () => {
    const { getAllByRole, queryByTestId } = render(
      <PracticeDrawer {...activeProps} sessionActive />,
    );
    const labels = getAllByRole('button').map(
      (r: { props: { accessibilityLabel: string } }) => r.props.accessibilityLabel,
    );
    // The two tab-flip rows are gone; the modal/push rows survive.
    expect(labels).toEqual(['Customize this practice', 'Practice details', 'Create a practice']);
    expect(queryByTestId('practice-drawer-change')).toBeNull();
    expect(queryByTestId('practice-drawer-browse')).toBeNull();
  });
});

describe('PracticeDrawer empty state (no active practice)', () => {
  it('renders exactly the browse and create rows, and no active-only rows', () => {
    const { getAllByRole, queryByTestId } = render(<PracticeDrawer {...emptyProps} />);
    const rows = getAllByRole('button');
    const labels = rows.map(
      (r: { props: { accessibilityLabel: string } }) => r.props.accessibilityLabel,
    );
    expect(labels).toEqual(['Browse all practices', 'Create a practice']);
    expect(queryByTestId('practice-drawer-change')).toBeNull();
    expect(queryByTestId('practice-drawer-customize')).toBeNull();
    expect(queryByTestId('practice-drawer-details')).toBeNull();
  });

  it('pressing "Browse all practices" flips to the embedded catalog and closes the drawer', () => {
    const onBrowseCatalog = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = render(
      <PracticeDrawer {...emptyProps} onBrowseCatalog={onBrowseCatalog} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('practice-drawer-browse'));
    expect(onBrowseCatalog).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('pressing "Create a practice" navigates to CreatePractice and closes the drawer', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<PracticeDrawer {...emptyProps} onClose={onClose} />);
    fireEvent.press(getByTestId('practice-drawer-create'));
    expect(mockNavigate).toHaveBeenCalledWith('CreatePractice');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
