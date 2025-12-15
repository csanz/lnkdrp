# Theme (LinkDrop)

LinkDrop is intentionally **black & white by default**. Only use a **pastel accent** when it improves clarity (e.g., a subtle success state) and there’s no black/white alternative.

## Core palette (default)

- **Black**: `#000000`
- **White**: `#FFFFFF`
- **Near-black (text)**: `#18181B` (Tailwind `zinc-900`)
- **Mid-gray (secondary text)**: `#52525B` (Tailwind `zinc-600`)
- **Light gray (borders/dividers)**: `#E4E4E7` (Tailwind `zinc-200`)

## Usage rules

- **Backgrounds**: white by default. Use black for primary CTAs or strong emphasis.
- **Text**: `zinc-900` primary, `zinc-600` secondary.
- **Borders**: prefer thin neutral borders (`zinc-200` / `zinc-300`) over tinted surfaces.
- **States**: rely on contrast, underline, weight, and border changes first.
- **Pastels**: allowed only for small, non-blocking accents (badges, tiny icons, subtle highlights).

## Pastel accents (only when necessary)

Choose one accent at a time. Keep it subtle and never replace core black/white contrast.

- **Mint (success/ready)**: `#A7F3D0` (Tailwind `emerald-200`)
- **Sky (info)**: `#BAE6FD` (Tailwind `sky-200`)
- **Rose (warning/error)**: `#FECDD3` (Tailwind `rose-200`)

## Components (defaults)

- **Primary button**: black background + white text, small radius, minimal shadow (optional).
- **Secondary button**: white background + black text, thin black border.
- **Focus**: default focus ring should be visible; prefer neutral ring (`zinc-900/20`) unless an accent is required.


