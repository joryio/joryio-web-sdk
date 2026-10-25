# Changelog

## 1.3.1 - 2026-10-24

Fixed: HTML modals and slide-ups are responsive. The message frame used to start narrow and take the width the content reported, so the author's media queries (for example `@media (max-width: 560px)`) fired even on a desktop screen. The frame is now given min(maxWidth, viewport width - 16px on each side) before the content loads (`maxWidth` comes from the "Max width" field in the dashboard; modal 600 and slide-up 400 when unset), re-fits when the window is resized, and only its height follows the content.

Fixed: the height is measured from the message body, so a message can shrink as well as grow (a form replaced by its thank-you line).

No API changes. Banner and fullscreen messages are unchanged.

## 1.3.0 - 2026-10-06

First public release.
