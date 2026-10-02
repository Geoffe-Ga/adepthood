/**
 * A focus spy that counts calls on ONE control.
 *
 * The React Native jest preset mocks ``View`` with its native methods on the
 * shared prototype, so ``jest.spyOn(instance, 'focus')`` patches every view at
 * once: focus moved to any other control would count. This spy records only
 * the calls whose receiver is the control's own instance.
 */
import { jest } from '@jest/globals';
import type { render } from '@testing-library/react-native';

type HostNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

/** The instance a ref to ``host`` resolves to: the nearest one with native methods. */
function focusableInstance(host: HostNode): { focus: () => void } {
  let node: HostNode | null = host;
  while (
    node != null &&
    typeof (node.instance as { focus?: unknown } | null)?.focus !== 'function'
  ) {
    node = node.parent;
  }
  if (node == null) throw new Error(`no focusable instance above ${String(host.props.testID)}`);
  return node.instance as { focus: () => void };
}

/** A mock called once per ``focus()`` on ``host``'s own instance, and on no other. */
export function spyOnFocus(host: HostNode): jest.Mock {
  const target = focusableInstance(host);
  const onTarget = jest.fn();
  jest.spyOn(target, 'focus').mockImplementation(function focus(this: unknown) {
    if (this === target) onTarget();
  });
  return onTarget;
}
