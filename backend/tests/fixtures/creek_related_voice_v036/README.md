# Related surfaces and voice 0.36

Creek contract 0.35 (Creek-Vault#2126, merged as #2142) adds `voice` to
`LetterResponse` and `ReflectionResponse`: `owner` when the owner's own
style shaped the text, `higher_self` otherwise. Creek applies the owner's
style only for a caller declaring 0.35 or later; an earlier caller keeps the
unchanged Higher Self prompt and never sees the field.

Creek contract 0.36 (Creek-Vault#2127, merged as #2144) adds
`ReflectionResponse.related_threads` (at most two `RelatedThread`) and, on
`LetterResponse`, `related_praxis` (at most three), `related_eddies` (at most
two) and `related_threads` (at most two). Each key is omitted -- not sent as
`[]` -- when nothing qualifies, and omitted for a caller declaring a minor
below 0.36.

These files are copied byte-for-byte from the pinned Creek-Vault commit in
`vendor.json`. The base `creek_v1` bundle and the 0.22 pin stay unchanged:
adepthood declares 0.36 on the reflection and letter calls only, and only to a
vault whose handshake lists 0.36 in `supported_contract_minors`. Every other
call keeps its own minor. Refresh this snapshot only from a reviewed immutable
commit.

The recorded SHA256 values are public artifact digests, not secrets.
