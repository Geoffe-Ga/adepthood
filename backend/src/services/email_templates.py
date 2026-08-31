"""Branded HTML bodies for outbound transactional mail.

Every message this module renders is the *alternative* half of a
``multipart/alternative`` pair.  The plain-text body remains the contract:
it is what a text-only client shows, what the dev console prints, and what
a screen reader falls back to.  The HTML exists so the first email a user
ever receives from Adepthood looks like Adepthood rather than like a
phishing attempt -- an unstyled wall of raw URLs is the single most
common shape of a credential-harvesting mail, and account recovery is
exactly the moment a user is primed to distrust one.

Three constraints shape everything here and are pinned by tests:

* **Inline styles only.**  Gmail strips ``<style>`` blocks outright, so a
  design that lives in a stylesheet renders as nothing in the client the
  majority of recipients use.
* **Tables for layout.**  Outlook's Word-based renderer does not implement
  flexbox or grid.  A ``<div>`` layout collapses there.
* **No script, no remote assets.**  Both are stripped or blocked, and both
  raise a message's spam score for no delivered benefit.

Colours are the Candle & Ink semantic tokens from
``frontend/src/design/tokens.ts``.  They are duplicated here rather than
imported because this is a Python service and that is a TypeScript module;
the duplication is deliberate and the palette test names the tokens so a
drift is visible rather than silent.
"""

from __future__ import annotations

from html import escape

# Candle & Ink semantic tokens (frontend/src/design/DESIGN.md).  Keys are
# snake_case renderings of the token path -- ``ink.primary`` -> ``ink_primary``.
PALETTE = {
    "canvas": "#faf6ef",
    "raised": "#ffffff",
    "desk": "#e7dcc8",
    "hairline": "#e3dccd",
    "ink_primary": "#2b2620",
    "ink_soft": "#5a5046",
    "ink_muted": "#6b6055",
    "accent_primary": "#a5572f",
    "accent_strong": "#8f4a28",
    "accent_on_primary": "#ffffff",
}

# The literary serif stack the product's reading surfaces use, with a web-safe
# fallback chain: mail clients have no webfont loading worth relying on.
_SERIF = "Iowan Old Style, Palatino, 'Palatino Linotype', Georgia, serif"
_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

# Wider than this and the measure exceeds a comfortable reading line; narrower
# and the button crowds its own padding on a phone.
_CONTENT_WIDTH_PX = 560


def _preheader(text: str) -> str:
    """Return the hidden inbox-preview line.

    Without one, clients preview whatever text comes first -- which, in a
    recovery email, is a raw tokenised URL.  The zero-width padding stops
    the client from pulling body copy in behind the intended preview.
    """
    hidden = (
        "display:none;font-size:1px;color:{canvas};line-height:1px;"
        "max-height:0;max-width:0;opacity:0;overflow:hidden;"
    ).format(canvas=PALETTE["canvas"])
    padding = "&#847;&zwnj;&nbsp;" * 30
    return f'<div class="preheader" style="{hidden}">{escape(text)}{padding}</div>'


def _button(href: str, label: str) -> str:
    """Return a table-based call-to-action that survives Outlook.

    An ``<a>`` with padding is not clickable across its whole area in the
    Word renderer, which is why the padding lives on the cell instead.
    """
    cell = (
        f"background-color:{PALETTE['accent_primary']};border-radius:6px;"
        "padding:14px 28px;text-align:center;"
    )
    anchor = (
        f"color:{PALETTE['accent_on_primary']};font-family:{_SANS};font-size:16px;"
        "font-weight:600;text-decoration:none;display:inline-block;"
    )
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
        f'<tr><td style="{cell}">'
        f'<a href="{href}" style="{anchor}">{escape(label)}</a>'
        "</td></tr></table>"
    )


def reset_email_html(origin: str, plaintext_token: str) -> str:
    """Render the password-reset email's HTML alternative.

    ``origin`` is deployment configuration (never a request header, for the
    reason ``_build_reset_email`` documents) and ``plaintext_token`` is
    escaped into every attribute it lands in.  The token is url-safe base64
    and cannot in practice carry markup, but it is the one value in this
    template that comes from outside it, so it is escaped on principle
    rather than on evidence.

    Both actions from the text body appear, and the native ``adepthood://``
    link is kept as a quiet secondary line: an installed build registers
    that scheme, and dropping it would fix nothing while breaking the
    platform the flow was originally written for.
    """
    token = escape(plaintext_token, quote=True)
    reset_url = f"{escape(origin, quote=True)}/reset-password?token={token}"
    cancel_url = f"{escape(origin, quote=True)}/cancel-reset?token={token}"
    app_url = f"adepthood://reset-password?token={token}"

    body_text = (
        f"color:{PALETTE['ink_primary']};font-family:{_SERIF};font-size:17px;"
        "line-height:1.55;margin:0;"
    )
    muted_text = (
        f"color:{PALETTE['ink_muted']};font-family:{_SANS};font-size:13px;line-height:1.5;margin:0;"
    )
    soft_link = f"color:{PALETTE['accent_strong']};text-decoration:underline;"
    wordmark = (
        f"color:{PALETTE['ink_soft']};font-family:{_SERIF};font-size:15px;"
        "letter-spacing:0.08em;text-transform:uppercase;margin:0;"
    )
    sheet = (
        f"background-color:{PALETTE['raised']};border:1px solid {PALETTE['hairline']};"
        "border-radius:10px;padding:36px 32px;"
    )
    rule = f"border:none;border-top:1px solid {PALETTE['hairline']};margin:28px 0;"

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Reset your Adepthood password</title>
</head>
<body style="margin:0;padding:0;background-color:{PALETTE["canvas"]};">
{_preheader("Reset your Adepthood password — this link expires in 30 minutes.")}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="background-color:{PALETTE["canvas"]};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       width="{_CONTENT_WIDTH_PX}" style="max-width:{_CONTENT_WIDTH_PX}px;width:100%;">
<tr><td style="padding:0 0 20px 4px;">
<p style="{wordmark}">Adepthood</p>
</td></tr>
<tr><td style="{sheet}">
<p style="{body_text}">Someone asked to reset the password for your Adepthood
account. If that was you, this is the way back in.</p>
<div style="padding:28px 0 8px;">{_button(reset_url, "Reset your password")}</div>
<p style="{muted_text}">This link expires in 30 minutes. Nothing changes until
you open it.</p>
<hr style="{rule}">
<p style="{muted_text}">Didn't ask for this? You can ignore this email — or
<a href="{cancel_url}" style="{soft_link}">cancel the request</a> to invalidate
the link immediately.</p>
<p style="{muted_text}padding-top:14px;">Have the app installed?
<a href="{app_url}" style="{soft_link}">Open it there instead</a>.</p>
</td></tr>
<tr><td style="padding:22px 4px 0;">
<p style="{muted_text}">You choose your depth.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""
