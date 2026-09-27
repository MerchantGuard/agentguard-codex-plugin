# Plugin assets

These assets are rasterizations of this repository's `assets/logo.svg`, with
its shapes and colors unchanged. `logo.svg` preserves the original source.

- `icon-32.png`: 32 by 32 pixels, small icon.
- `icon-128.png`: 128 by 128 pixels, manifest composer icon.
- `logo-256.png`: 256 by 256 pixels, alternate logo.
- `logo-512.png`: 512 by 512 pixels, manifest logo.
- `social-card.png`: 1280 by 640 pixels, the README banner and the repository's social preview. Rendered from a static HTML card (Inter and JetBrains Mono, the product shot is the final frame of the Sep 20 fan-out replay); not derived from `logo.svg`.

The [packaging documentation](https://developers.openai.com/plugins/build/plugins#add-openai-specific-metadata)
specifies icon and logo paths but does not prescribe pixel dimensions. These
sizes are packaging choices, not a claim about an undocumented requirement.
