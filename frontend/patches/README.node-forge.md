# node-forge signature verification backport

`node-forge+1.4.0.patch` applies the exact nested `DigestAlgorithm` element-count
check from [forge PR #1152](https://github.com/digitalbazaar/forge/pull/1152), pinned
at `ceba34402e329f0365134f23fe19898756527d65`. It addresses
GHSA-86w9-cpqp-85rv / CVE-2026-85393 without relaxing padding or ASN.1 parsing.
The count includes the optional parameters element, so both valid SHA-256 NULL
parameters and valid omitted parameters remain accepted.

The normal `patch-package` postinstall applies this alongside the existing
`@expo/plist` compatibility patch. The installed-library regression runs Node
outside Jest's module mocks. It rejects the published malformed signature and
extra nested elements with and without parameters, and verifies valid signatures
in all three controls. The public upstream fixture's BSD notice is preserved in
`__tests__/fixtures/node-forge.NOTICE`; no private key is included.

On 2026-10-14, the public npm registry still publishes only 1.4.0 as latest, and
upstream PR #1152 remains open at the pinned commit. npm audit therefore still
reports the affected version even with this local fix. The existing advisory
exception retains its enforced **2026-10-16** expiry and recheck issue #3023; this
backport does not extend it or suppress another advisory. The unrelated braces
exception remains unchanged.

When a fixed upstream release is published, upgrade the resolved dependency,
remove this patch and only the node-forge advisory exception, and remove the
backport-specific version/expiry test. Keep the signature regressions and their
public fixture. Verify a clean `npm ci`, the installed-library regression, and the
full frontend gate. Track implementation in #3022 and release rechecking in #3023.
