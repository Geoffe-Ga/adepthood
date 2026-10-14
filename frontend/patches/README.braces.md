# braces recursion-depth backport

`braces+3.0.3.patch` backports the mandatory parser and recursive-walker depth
checks from [braces PR #78](https://github.com/micromatch/braces/pull/78), pinned
at `97308a01d091b211cf015314a2d0696da28a5392`. Only that PR's six library-source
changes are included; unrelated parser changes already present on upstream
master are excluded. The source is MIT licensed by Jon Schlinkert; the license
is preserved in `braces.LICENSE` and in the installed package.

The parser bounds nested brace and parenthesis containers. Compile, expand and
stringify independently check recursive depth, including caller-provided ASTs.
The fixed maximum is 100 and cannot be raised through options. Parser container
counts and walker call depth differ at the boundary because walkers may also
visit terminal nodes. Excessive nesting throws a controlled `SyntaxError`
instead of exhausting the JavaScript stack. The existing input-length and range
limits are unchanged. This patch does not bound expansion output, all CPU work,
or arbitrary malformed AST structures.

The installed-library regression invokes Node with a bounded stack and deadline,
outside Jest's module mocks. It covers deep strings, direct ASTs, 100/101 walker
boundaries, unclosed containers, installed micromatch facades, repeated shared
nodes, and ordinary range/escape/glob behavior. Normal `npm ci` applies the patch
through the existing `patch-package` postinstall.

On 2026-10-14, npm still publishes 3.0.3 as latest and PR #78 remains open.
The installed backport does not make this an advisory-recognized patched npm
release. GHSA-vfj7-8cjw-p6xm remains allowlisted only until the existing enforced
**2026-10-19** expiry under #3054. This change does not renew the exception or
change the unrelated Forge expiry. Recheck the registry and advisory before
expiry; when a verified patched release is available, upgrade, remove this
patch and the exact braces exception, and retain the behavioral regressions.

Implementation is tracked in #3280. Parent #3054 remains open for recognized
patched-dependency adoption and exception removal.
