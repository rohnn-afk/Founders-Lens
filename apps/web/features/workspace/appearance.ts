export const appearanceKey = 'founders-lens.appearance';
export const appearances = ['system', 'light', 'dark'] as const;
export type Appearance = typeof appearances[number];
