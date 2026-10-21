// Each supplied PNG uses the same 1672 × 941 scene coordinates. These boxes
// describe visible click areas, so transparent canvas never intercepts clicks.
// The two tightly packed side guests use their head/shoulder area to avoid a neighbour.
export const W = 1672, H = 941;
export const seats = [
  { file: '01-puzzle-shirt', name: 'Puzzle shirt', box: [754, 257, 154, 160] },
  { file: '02-black-blouse', name: 'Black blouse', box: [955, 277, 148, 143] },
  { file: '03-dark-haired-man', name: 'Dark-haired man', box: [1125, 293, 158, 171] },
  { file: '04-short-haired-man', name: 'Short-haired man', box: [1300, 343, 106, 78] },
  { file: '05-tan-jacket', name: 'Tan jacket', box: [1296, 421, 216, 381], dx: -65 },
  { file: '06-floral-hair', name: 'Flowers in hair', box: [1080, 491, 216, 303] },
  { file: '07-back-center', name: 'Back to camera', box: [706, 525, 259, 212] },
  { file: '08-long-haired-woman', name: 'Long-haired woman', box: [405, 487, 210, 310] },
  { file: '09-gray-beard', name: 'Gray beard', box: [182, 404, 197, 390], dx: 45 },
  { file: '10-gray-hoodie', name: 'Gray hoodie', box: [300, 336, 100, 70] },
  { file: '11-gold-chain', name: 'Gold chain', box: [412, 277, 152, 177] },
  { file: '12-redhead', name: 'Redhead', box: [594, 275, 137, 143] },
];
const assets = import.meta.glob('./assets/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export function asset(path: string) {
  const url = assets[`./assets/${path}.png`];
  if (!url) throw new Error(`Missing lounge asset: ${path}.png`);
  return url;
}
