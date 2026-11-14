const { XMLParser } = require('fast-xml-parser');

const atomicWeights = { H: 1.008, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Br: 79.904, I: 126.904, Na: 22.990, Mg: 24.305, Al: 26.982, K: 39.098, Ca: 40.078, Fe: 55.845, Cu: 63.546, Zn: 65.38, Mn: 54.938, Co: 58.933, Ni: 58.693, Pt: 195.084, Pd: 106.42 };
const valences = { H: [1], B: [3], C: [4], N: [3, 5], O: [2], F: [1], Si: [4], P: [3, 5], S: [2, 4, 6], Cl: [1], Br: [1], I: [1], Na: [0], Mg: [0], Al: [3], K: [0], Ca: [0], Fe: [2, 3], Cu: [1, 2], Zn: [2], Mn: [2, 4, 7], Co: [2, 3], Ni: [2, 3], Pt: [2, 4], Pd: [2, 4] };
const elementsByAtomicNumber = ['', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg'];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, trimValues: true });

function list(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function esc(value) { return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]); }
function extractText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractText).join('');
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !key.startsWith('@_')).map(([, child]) => extractText(child)).join('');
  return '';
}

function parseCdxml(buffer) {
  const tree = parser.parse(buffer.toString('utf8'));
  const nodes = [];
  const bonds = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.n) for (const node of list(value.n)) nodes.push(node);
    if (value.b) for (const bond of list(value.b)) bonds.push(bond);
    for (const [key, child] of Object.entries(value)) if (key !== 'n' && key !== 'b') {
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  }
  walk(tree);
  const atoms = nodes.map((node, index) => {
    const label = extractText(node.t || node.Label || '').trim();
    const rawElement = String(node.Element || '').trim();
    const element = /^\d+$/.test(rawElement) ? elementsByAtomicNumber[Number(rawElement)] || label.match(/^[A-Z][a-z]?/)?.[0] || 'C' : rawElement.match(/^[A-Z][a-z]?/)?.[0] || label.match(/^[A-Z][a-z]?/)?.[0] || 'C';
    const raw = label || element;
    const [x = index * 30, y = 0] = String(node.p || `${index * 30} 0`).split(/[ ,]+/).map(Number);
    return { id: String(node.id ?? index), element, label: raw, x: Number.isFinite(x) ? x : index * 30, y: Number.isFinite(y) ? y : 0, bondOrder: 0 };
  });
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const parsedBonds = bonds.map((bond) => {
    const start = byId.get(String(bond.B));
    const end = byId.get(String(bond.E));
    const order = ({ '1': 1, '2': 2, '3': 3, '1.5': 1.5 })[String(bond.Order || '1')] || 1;
    if (start && end) { start.bondOrder += order; end.bondOrder += order; }
    return { start, end, order };
  }).filter((bond) => bond.start && bond.end);
  if (!atoms.length) throw new Error('No atoms were found in this CDXML file.');

  const counts = {};
  for (const atom of atoms) {
    counts[atom.element] = (counts[atom.element] || 0) + 1;
    const choices = valences[atom.element];
    if (choices) {
      const valence = choices.find((candidate) => candidate >= atom.bondOrder) ?? choices.at(-1);
      const hydrogens = Math.max(0, Math.floor(valence - atom.bondOrder + 1e-5));
      if (hydrogens) counts.H = (counts.H || 0) + hydrogens;
    }
  }
  const orderElements = ['C', 'H', ...Object.keys(counts).filter((element) => element !== 'C' && element !== 'H').sort()];
  const formula = orderElements.filter((element) => counts[element]).map((element) => `${element}${counts[element] > 1 ? counts[element] : ''}`).join('');
  const molecularWeight = Object.entries(counts).reduce((sum, [element, count]) => sum + (atomicWeights[element] || 0) * count, 0);

  const minX = Math.min(...atoms.map((atom) => atom.x));
  const maxX = Math.max(...atoms.map((atom) => atom.x));
  const minY = Math.min(...atoms.map((atom) => atom.y));
  const maxY = Math.max(...atoms.map((atom) => atom.y));
  const width = Math.max(120, maxX - minX + 60);
  const height = Math.max(100, maxY - minY + 60);
  const point = (atom) => ({ x: atom.x - minX + 30, y: maxY - atom.y + 30 });
  const lines = parsedBonds.map(({ start, end, order }) => {
    const a = point(start); const b = point(end);
    if (order < 2) return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.max(1, Math.hypot(dx, dy));
    const offsetX = (dy / length) * 4; const offsetY = (-dx / length) * 4;
    const copies = order >= 3 ? [-1, 0, 1] : [-1, 1];
    return copies.map((factor) => `<line x1="${a.x + offsetX * factor}" y1="${a.y + offsetY * factor}" x2="${b.x + offsetX * factor}" y2="${b.y + offsetY * factor}"/>`).join('');
  }).join('');
  const labels = atoms.map((atom) => {
    if (atom.element === 'C' && atom.label === 'C') return '';
    const p = point(atom);
    return `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle">${esc(atom.label)}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Molecular structure"><g fill="none" stroke="#173e36" stroke-width="2" stroke-linecap="round">${lines}</g><g fill="#173e36" font-family="sans-serif" font-size="16" font-weight="600">${labels}</g></svg>`;
  return { formula, molecularWeight: Number(molecularWeight.toFixed(4)), svg };
}

const cdxObjectNames = new Map([[0x8000,'document'],[0x8001,'page'],[0x8003,'fragment'],[0x8004,'node'],[0x8005,'bond'],[0x8006,'text']]);

function parseCdx(buffer) {
  if (buffer.toString('ascii', 0, 8) !== 'VjCD0100') throw new Error('This is not a ChemDraw CDX file.');
  let offset = 22;
  function readObject() {
    if (offset + 2 > buffer.length) throw new Error('The CDX file ended unexpectedly.');
    const tag = buffer.readUInt16LE(offset); offset += 2;
    if (tag === 0) return null;
    if (!(tag & 0x8000)) throw new Error('The CDX file contains a property outside an object.');
    if (offset + 4 > buffer.length) throw new Error('The CDX object header is incomplete.');
    const object = { tag, id: buffer.readUInt32LE(offset), props: new Map(), children: [] };
    offset += 4;
    while (true) {
      if (offset + 2 > buffer.length) throw new Error('The CDX object is missing its end marker.');
      const start = offset;
      const property = buffer.readUInt16LE(offset); offset += 2;
      if (property === 0) break;
      if (property & 0x8000) {
        offset = start;
        const child = readObject();
        if (child) object.children.push(child);
        continue;
      }
      if (offset + 2 > buffer.length) throw new Error('The CDX property has no length.');
      let length = buffer.readUInt16LE(offset); offset += 2;
      if (length === 0xffff) {
        if (offset + 4 > buffer.length) throw new Error('The CDX property length is incomplete.');
        length = buffer.readUInt32LE(offset); offset += 4;
      }
      if (offset + length > buffer.length) throw new Error('The CDX property is truncated.');
      object.props.set(property, buffer.subarray(offset, offset + length));
      offset += length;
    }
    return object;
  }

  const root = readObject();
  if (!root || root.tag !== 0x8000 || offset !== buffer.length - 2 || buffer.readUInt16LE(offset) !== 0) {
    throw new Error('The CDX document layout is not supported for preview rendering.');
  }
  const nodes = [];
  const bonds = [];
  function walk(object) {
    if (object.tag === 0x8004) nodes.push(object);
    else if (object.tag === 0x8005) bonds.push(object);
    else if (!cdxObjectNames.has(object.tag)) throw new Error(`The CDX object type ${object.tag.toString(16)} is not supported for preview rendering.`);
    object.children.forEach(walk);
  }
  walk(root);
  if (!nodes.length || !bonds.length) throw new Error('No molecular atoms and bonds were found in this CDX file.');

  const atoms = nodes.map((object) => {
    const point = object.props.get(0x0200);
    if (!point || point.length !== 8) throw new Error('A CDX atom is missing its 2D position.');
    const atomicNumber = object.props.has(0x0402) ? object.props.get(0x0402).readUInt16LE(0) : 6;
    const element = elementsByAtomicNumber[atomicNumber];
    if (!element) throw new Error(`Atomic number ${atomicNumber} is not supported for preview rendering.`);
    const textObject = object.children.find((child) => child.tag === 0x8006);
    const textBytes = textObject?.props.get(0x0700);
    // ChemDraw's text runs in these files have a 10-byte style prefix followed by the visible atom label.
    let label = textBytes?.length > 10 ? textBytes.subarray(10).toString('utf8').replace(/\0.*$/s, '').trim() : '';
    if (!label && element !== 'C') label = element;
    const charge = object.props.get(0x0421)?.readInt8(0) || 0;
    if (label && charge && !/[+-]/.test(label)) label += charge > 0 ? '+' : '−';
    return {
      id: object.id,
      element,
      label,
      x: point.readInt32LE(4),
      y: point.readInt32LE(0)
    };
  });
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const parsedBonds = bonds.map((object) => {
    const begin = object.props.get(0x0604);
    const end = object.props.get(0x0605);
    if (!begin || !end || begin.length !== 4 || end.length !== 4) throw new Error('A CDX bond is missing an endpoint.');
    const start = byId.get(begin.readUInt32LE(0));
    const finish = byId.get(end.readUInt32LE(0));
    if (!start || !finish) throw new Error('A CDX bond refers to an unknown atom.');
    const rawOrder = object.props.get(0x0600)?.readUInt16LE(0) || 1;
    // ChemDraw stores a triple bond as the bit value 0x0004; older imported files may use 3.
    const order = rawOrder === 4 ? 3 : rawOrder;
    if (![1, 2, 3].includes(order)) throw new Error(`Bond order ${rawOrder} is not supported for preview rendering.`);
    return { start, end: finish, order };
  });

  const meanBondLength = parsedBonds.reduce((total, bond) => total + Math.hypot(bond.end.x - bond.start.x, bond.end.y - bond.start.y), 0) / parsedBonds.length;
  const scale = 54 / meanBondLength;
  const margin = 30;
  const minX = Math.min(...atoms.map((atom) => atom.x));
  const maxX = Math.max(...atoms.map((atom) => atom.x));
  const minY = Math.min(...atoms.map((atom) => atom.y));
  const maxY = Math.max(...atoms.map((atom) => atom.y));
  const width = Math.max(180, (maxX - minX) * scale + margin * 2);
  const height = Math.max(160, (maxY - minY) * scale + margin * 2);
  const point = (atom) => ({ x: margin + (atom.x - minX) * scale, y: margin + (atom.y - minY) * scale });
  const lines = parsedBonds.map(({ start, end, order }) => {
    const a = point(start); const b = point(end);
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.max(1, Math.hypot(dx, dy));
    const offsetX = (dy / length) * 2.2; const offsetY = (-dx / length) * 2.2;
    const offsets = order === 3 ? [-1, 0, 1] : order === 2 ? [-0.7, 0.7] : [0];
    return offsets.map((factor) => `<line x1="${a.x + offsetX * factor}" y1="${a.y + offsetY * factor}" x2="${b.x + offsetX * factor}" y2="${b.y + offsetY * factor}"/>`).join('');
  }).join('');
  const labels = atoms.filter((atom) => atom.label).map((atom) => {
    const p = point(atom);
    return `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle" paint-order="stroke" stroke="#fff" stroke-width="5" stroke-linejoin="round">${esc(atom.label)}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="ChemDraw structure preview"><rect width="100%" height="100%" fill="#fff"/><g fill="none" stroke="#173e36" stroke-width="2" stroke-linecap="round">${lines}</g><g fill="#173e36" font-family="Arial,sans-serif" font-size="17" font-weight="500">${labels}</g></svg>`;
  return { svg, atomCount: atoms.length, bondCount: parsedBonds.length };
}

module.exports = { parseCdxml, parseCdx };
