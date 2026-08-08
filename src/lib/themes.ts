import type { ThemeId } from '../../shared/types'

export interface ThemeDefinition {
  id: ThemeId
  name: string
  origin: string
  description: string
  mode: 'light' | 'dark'
  swatches: [string, string, string, string]
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'navy-gold',
    name: 'Royal Archive',
    origin: 'Navy · Ivory · Gold',
    description: 'Crisp white workspace with a naval command spine and restrained gold detail.',
    mode: 'light',
    swatches: ['#f7f4ec', '#ffffff', '#0b2342', '#c7a24b'],
  },
  {
    id: 'song-porcelain',
    name: 'Song Porcelain',
    origin: 'China · Blue & White',
    description: 'Porcelain white, deep cobalt, pale celadon, and one measured cinnabar accent.',
    mode: 'light',
    swatches: ['#f6fafb', '#dfeceb', '#174a78', '#b84a42'],
  },
  {
    id: 'kyoto-washi',
    name: 'Kyoto Washi',
    origin: 'Japan · Paper & Indigo',
    description: 'Warm handmade paper, quiet indigo, persimmon red, and ink-soft neutrals.',
    mode: 'light',
    swatches: ['#f4ecdc', '#e8dcc4', '#29345e', '#bd553e'],
  },
  {
    id: 'bauhaus',
    name: 'Bauhaus Studio',
    origin: 'Germany · Primary Geometry',
    description: 'Ivory and black structure energized by primary red, blue, and yellow.',
    mode: 'light',
    swatches: ['#f4f0e6', '#181818', '#d63a32', '#efbf3a'],
  },
  {
    id: 'swiss-modern',
    name: 'Swiss Modern',
    origin: 'Switzerland · Editorial',
    description: 'Brilliant white, disciplined charcoal, and a decisive editorial red.',
    mode: 'light',
    swatches: ['#fbfbfa', '#e9e9e6', '#202020', '#e23832'],
  },
  {
    id: 'art-deco',
    name: 'Art Deco Salon',
    origin: 'Paris · Emerald & Brass',
    description: 'Blackened emerald panels, champagne brass, and a theatrical evening glow.',
    mode: 'dark',
    swatches: ['#091411', '#12251f', '#d0af61', '#e9dfc8'],
  },
  {
    id: 'nordic-fjord',
    name: 'Nordic Fjord',
    origin: 'Scandinavia · Mist & Pine',
    description: 'Cool morning mist, pine-blue navigation, glacier blue, and pale timber.',
    mode: 'light',
    swatches: ['#eef4f3', '#dce9e7', '#264d57', '#78a5a6'],
  },
  {
    id: 'mediterranean',
    name: 'Mediterranean',
    origin: 'Aegean · Sun & Cobalt',
    description: 'Sunlit plaster, Aegean cobalt, terracotta, and warm coastal sand.',
    mode: 'light',
    swatches: ['#fff8e8', '#ffffff', '#1a4b85', '#c86d48'],
  },
  {
    id: 'sahara',
    name: 'Sahara Atelier',
    origin: 'North Africa · Sand & Clay',
    description: 'Layered sand, date-palm brown, fired clay, and desert brass.',
    mode: 'light',
    swatches: ['#f3e6ca', '#e5d2ad', '#5a3a2b', '#b65f3d'],
  },
  {
    id: 'sakura',
    name: 'Sakura Editorial',
    origin: 'Tokyo · Plum & Blossom',
    description: 'Nearly-white blossom pink, deep plum, rose, and a soft tea-paper neutral.',
    mode: 'light',
    swatches: ['#fff5f7', '#f5e5ea', '#59314f', '#d6657e'],
  },
  {
    id: 'persian-night',
    name: 'Persian Night',
    origin: 'Isfahan · Turquoise & Saffron',
    description: 'Midnight tile blue, luminous turquoise, saffron gold, and moonlit text.',
    mode: 'dark',
    swatches: ['#081a29', '#102b3c', '#38c0b4', '#e5b950'],
  },
  {
    id: 'solarpunk',
    name: 'Solarpunk Garden',
    origin: 'Future Earth · Leaf & Sun',
    description: 'Airy plant whites, living green, clear water blue, and solar yellow.',
    mode: 'light',
    swatches: ['#f0f7e9', '#ffffff', '#235b43', '#dfb73f'],
  },
  {
    id: 'cyber-tokyo',
    name: 'Cyber Tokyo',
    origin: 'Neo Tokyo · Cyan & Magenta',
    description: 'Inky violet control surfaces cut with electric cyan and neon magenta.',
    mode: 'dark',
    swatches: ['#090817', '#18122b', '#00d8d0', '#ff4fc8'],
  },
  {
    id: 'arctic',
    name: 'Arctic Research',
    origin: 'Polar · Ice & Slate',
    description: 'Snow white, translucent ice blue, research-station slate, and clear cyan.',
    mode: 'light',
    swatches: ['#f4fafc', '#e0f0f5', '#2d4f63', '#4a9db6'],
  },
  {
    id: 'carnival',
    name: 'Carnival Modern',
    origin: 'Latin America · Teal & Fuchsia',
    description: 'Warm festival paper with saturated teal, fuchsia, and marigold energy.',
    mode: 'light',
    swatches: ['#fff7e8', '#f7e5cc', '#185661', '#d13f75'],
  },
  {
    id: 'forest-studio',
    name: 'Forest Studio',
    origin: 'Craft · Moss & Walnut',
    description: 'Natural paper, moss green, walnut brown, and a calm botanical workspace.',
    mode: 'light',
    swatches: ['#f2efe5', '#e4e3d4', '#2d4432', '#a67447'],
  },
  {
    id: 'vscode-dark',
    name: 'VS Code Dark',
    origin: 'VS Code · Dark',
    description: 'A restrained workbench built from familiar editor charcoal, blue, and cool gray.',
    mode: 'dark',
    swatches: ['#1e1e1e', '#252526', '#007acc', '#d4d4d4'],
  },
  {
    id: 'vscode-light',
    name: 'VS Code Light',
    origin: 'VS Code · Light',
    description: 'A clean editor-white workspace with crisp dividers and the familiar VS Code blue.',
    mode: 'light',
    swatches: ['#f3f3f3', '#ffffff', '#005fb8', '#1f1f1f'],
  },
  {
    id: 'monochrome',
    name: 'Pure Monochrome',
    origin: 'Black · White',
    description: 'A strict black-and-white interface with hierarchy carried only by line, weight, and space.',
    mode: 'light',
    swatches: ['#ffffff', '#ffffff', '#000000', '#000000'],
  },
]

export const DEFAULT_THEME = THEMES[0]
