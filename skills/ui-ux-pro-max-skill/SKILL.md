---
name: ui-ux-pro-max-skill
description: Design intelligence for building professional UI/UX. Searchable databases of UI styles, color palettes, font pairings, landing page patterns, chart types, and UX guidelines. Use when designing or building frontend UIs, websites, dashboards, or mockups — especially for agency client work. Supports React, Next.js, Tailwind, and more.
---

# UI/UX Pro Max

AI-powered design intelligence toolkit. Use this to make informed design decisions before writing a single line of code.

## Search Command

```bash
python3 ~/.openclaw/workspace/skills/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/search.py "<query>" --domain <domain> -n <results>
```

## Domains

| Domain | What it gives you |
|---|---|
| `product` | Product type recommendations (SaaS, e-commerce, portfolio) |
| `style` | UI styles (glassmorphism, minimalism, brutalism) + CSS keywords |
| `typography` | Font pairings with Google Fonts imports |
| `color` | Color palettes by product type |
| `landing` | Page structure, section order, CTA strategies |
| `chart` | Chart types and library recommendations |
| `ux` | Best practices and anti-patterns |

## Stack Support

Add `--stack <stack>` for framework-specific guidelines:
`html-tailwind` (default), `react`, `nextjs`, `astro`, `vue`, `nuxtjs`, `svelte`, `shadcn`, `react-native`, `flutter`

## Examples

```bash
# What style suits a fintech SaaS?
python3 .../search.py "fintech dashboard" --domain style -n 3

# Font pairing for a luxury brand
python3 .../search.py "luxury minimal" --domain typography -n 2

# Landing page structure for a SaaS product
python3 .../search.py "SaaS conversion" --domain landing -n 3

# React-specific component guidelines
python3 .../search.py "data visualization" --domain chart --stack react -n 3
```

## Usage Pattern

1. Run a search before starting design work
2. Pick the pattern/style that fits the client's product type
3. Use the CSS keywords and color strategies as your foundation
4. Reference the font pairings for typography decisions
