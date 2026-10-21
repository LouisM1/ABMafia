// Each supplied PNG uses the same 1672 × 941 scene coordinates. These boxes
// describe visible click areas, so transparent canvas never intercepts clicks.
// The two tightly packed side guests use their head/shoulder area to avoid a neighbour.
export const W = 1672, H = 941;
// Visual order: top seat, then clockwise. Moxie is the human’s seat.
export const seats = [
  { file: 'palmer-luckey', personaId: 'palmer_luckey', name: 'Palmer Luckey', box: [754, 257, 154, 160] },
  { file: 'ryan-beiermeister', personaId: 'ryan_beiermeister', name: 'Ryan Beiermeister', box: [955, 277, 148, 143] },
  { file: 'tim-urban', personaId: 'tim_urban', name: 'Tim Urban', box: [1125, 293, 158, 171] },
  { file: 'sam-altman', personaId: 'sam_altman', name: 'Sam Altman', box: [1300, 343, 106, 78] },
  { file: 'ryan-petersen', personaId: 'ryan_petersen', name: 'Ryan Petersen', box: [1296, 421, 216, 381], dx: -65 },
  { file: 'josie-zayner', personaId: 'josie_zayner', name: 'Josie Zayner', box: [1080, 491, 216, 303] },
  { file: 'moxie-marlinspike', personaId: 'moxie_marlinspike', name: 'Moxie Marlinspike', box: [706, 525, 259, 212] },
  { file: 'liv-boeree', personaId: 'liv_boeree', name: 'Liv Boeree', box: [405, 487, 210, 310] },
  { file: 'trae-stephens', personaId: 'trae_stephens', name: 'Trae Stephens', box: [182, 404, 197, 390], dx: 45 },
  { file: 'dylan-field', personaId: 'dylan_field', name: 'Dylan Field', box: [300, 336, 100, 70] },
  { file: 'bryan-johnson', personaId: 'bryan_johnson', name: 'Bryan Johnson', box: [412, 277, 152, 177] },
  { file: 'cyan-banister', personaId: 'cyan_banister', name: 'Cyan Banister', box: [594, 275, 137, 143] },
];
const assets = import.meta.glob('./assets/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export function asset(path: string) {
  const url = assets[`./assets/${path}.png`];
  if (!url) throw new Error(`Missing lounge asset: ${path}.png`);
  return url;
}
