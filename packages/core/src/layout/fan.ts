/**
 * Fan chart: the focus person is a disc at the origin and each ancestor
 * generation a ring around it. Every ring is split into 2^g equal slots by
 * Ahnentafel number, so a person's parents always sit directly outside them,
 * father on the start (left) side. Missing ancestors leave empty slots.
 */
import { Builder, settingsFrom } from './build';
import {
  asIndex,
  chooseParentFamily,
  coupleOrder,
  partneredParentFamilies,
  type GraphSource,
} from './graph';
import { boundsOf } from './output';
import type { Bounds, FanLayout, FanOptions, FanSegment, FanSlot } from './types';
import { maxOf, minOf } from './arrays';

export function layoutFan(
  graph: GraphSource,
  focusId: string,
  options: FanOptions = {},
): FanLayout {
  const index = asIndex(graph);
  const generations = Math.max(1, Math.floor(options.generations ?? 6));
  const inner = options.innerRadius ?? 60;
  const ring = options.ringWidth ?? 70;
  const sweep = options.sweep ?? Math.PI;
  const start = (3 * Math.PI) / 2 - sweep / 2;
  if (!index.person(focusId)) {
    return {
      focusKey: null,
      segments: [],
      emptySlots: [],
      bounds: boundsOf([]),
      alternateParentFamilies: {},
    };
  }
  const b = new Builder(index, settingsFrom(options, { ancestorsDepth: 0, descendantsDepth: 0 }));

  const segments: FanSegment[] = [];
  const emptySlots: FanSlot[] = [];
  /** The ring segment of an Ahnentafel number. */
  const place = (ahnentafel: number): FanSlot => {
    const generation = Math.floor(Math.log2(ahnentafel));
    const per = sweep / 2 ** generation;
    const slot = ahnentafel - 2 ** generation;
    return {
      generation,
      ahnentafel,
      startAngle: start + slot * per,
      endAngle: start + (slot + 1) * per,
      innerRadius: generation === 0 ? 0 : inner + (generation - 1) * ring,
      outerRadius: inner + generation * ring,
    };
  };
  const queue: { personId: string; ahnentafel: number; generation: number }[] = [
    { personId: focusId, ahnentafel: 1, generation: 0 },
  ];
  for (let i = 0; i < queue.length; i++) {
    const { personId, ahnentafel, generation } = queue[i]!;
    const card = b.card(personId, generation === 0 ? 'focus' : 'ancestor', -generation);
    const segment: FanSegment = {
      key: card.key,
      personId,
      ...place(ahnentafel),
      isFocus: generation === 0,
      isDuplicate: card.dupOf !== undefined,
    };
    if (card.dupOf !== undefined) {
      segment.duplicateOf = card.dupOf;
      segments.push(segment);
      continue;
    }
    segments.push(segment);
    const families = partneredParentFamilies(index, personId);
    const family = chooseParentFamily(index, personId, b.s.selected);
    if (family && families.length > 1) {
      b.alternates[personId] = { selected: family.id, families: families.map((f) => f.id) };
    }
    if (generation + 1 >= generations || b.budget(personId, 'up', 1) === 0) continue;
    const parents = family ? coupleOrder(index, family) : [];
    // Slot by role, not by position: a lone mother keeps the mother's slot.
    const [father, mother] =
      parents.length !== 1 || index.person(parents[0]!)!.sex !== 'F'
        ? parents
        : [undefined, parents[0]];
    const next = generation + 1;
    // An unknown parent's slot is drawn empty rather than left as a gap, unless
    // the database has parents this slice left out.
    const unknown = index.person(personId)!.hasMoreParents !== true;
    if (father) queue.push({ personId: father, ahnentafel: 2 * ahnentafel, generation: next });
    else if (unknown) emptySlots.push(place(2 * ahnentafel));
    if (mother) queue.push({ personId: mother, ahnentafel: 2 * ahnentafel + 1, generation: next });
    else if (unknown) emptySlots.push(place(2 * ahnentafel + 1));
  }

  const radius = inner + (generations - 1) * ring;
  return {
    focusKey: segments[0]!.key,
    segments,
    emptySlots,
    bounds: sectorBounds(start, sweep, radius),
    alternateParentFamilies: b.alternates,
  };
}

/** Bounding box of a circular sector at the origin. */
function sectorBounds(start: number, sweep: number, radius: number): Bounds {
  const xs = [0];
  const ys = [0];
  const add = (angle: number) => {
    xs.push(Math.cos(angle) * radius);
    ys.push(Math.sin(angle) * radius);
  };
  add(start);
  add(start + sweep);
  // Axis extremes the arc passes through.
  for (let k = Math.ceil(start / (Math.PI / 2)); k * (Math.PI / 2) <= start + sweep; k++) {
    add(k * (Math.PI / 2));
  }
  const clean = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
  const minX = clean(minOf(xs));
  const maxX = clean(maxOf(xs));
  const minY = clean(minOf(ys));
  const maxY = clean(maxOf(ys));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
